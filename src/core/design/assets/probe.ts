/**
 * Intrinsic dimensions, read from file headers.
 *
 * Written rather than installed. The dependency list for this project is six
 * packages, and adding a seventh to read four well-documented headers is a poor
 * trade — especially for a directory anything can write into, where the parser
 * is reading untrusted bytes and every read wants a bounds check anyway.
 *
 * Formats Caret cannot measure return null dimensions rather than a guess. That
 * is a supported state: the entry still indexes, still serves, and still carries
 * its description, which is the field that actually decides placement.
 */

export interface Dimensions {
	width: number
	height: number
}

/** Reads intrinsic size from the first bytes of a file. Null when unknown. */
export function probeDimensions(buffer: Buffer, extension: string): Dimensions | null {
	try {
		switch (extension.toLowerCase()) {
			case ".png":
				return probePng(buffer)
			case ".jpg":
			case ".jpeg":
				return probeJpeg(buffer)
			case ".gif":
				return probeGif(buffer)
			case ".webp":
				return probeWebp(buffer)
			case ".svg":
				return probeSvg(buffer.toString("utf-8"))
			default:
				// AVIF, video and 3D need a real container parse or a decoder. Better
				// to say "unknown" than to ship a header parser nothing verified.
				return null
		}
	} catch {
		return null
	}
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function probePng(buffer: Buffer): Dimensions | null {
	// Signature, then a 4-byte length, "IHDR", then width and height.
	if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
	if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function probeJpeg(buffer: Buffer): Dimensions | null {
	if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null

	let offset = 2
	while (offset + 9 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			// Fill bytes are legal between segments; anything else means the file is
			// malformed and guessing past it would produce a confident wrong answer.
			offset++
			continue
		}

		const marker = buffer[offset + 1]
		const length = buffer.readUInt16BE(offset + 2)

		// SOF0..SOF15, excluding the four that are not frame headers (DHT, JPG,
		// DAC, and the restart markers). Height precedes width here, unlike PNG.
		const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
		if (isFrameHeader) {
			return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
		}

		if (length < 2) return null
		offset += 2 + length
	}
	return null
}

function probeGif(buffer: Buffer): Dimensions | null {
	if (buffer.length < 10) return null
	const signature = buffer.subarray(0, 6).toString("ascii")
	if (signature !== "GIF87a" && signature !== "GIF89a") return null
	return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
}

function probeWebp(buffer: Buffer): Dimensions | null {
	if (buffer.length < 30) return null
	if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return null
	if (buffer.subarray(8, 12).toString("ascii") !== "WEBP") return null

	// Three incompatible layouts behind one extension.
	const format = buffer.subarray(12, 16).toString("ascii")
	if (format === "VP8 ") {
		return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
	}
	if (format === "VP8L") {
		// 14 bits each, packed across four bytes, both stored minus one.
		const bits = buffer.readUInt32LE(21)
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
	}
	if (format === "VP8X") {
		// 24-bit little-endian, stored minus one.
		const width = buffer.readUIntLE(24, 3) + 1
		const height = buffer.readUIntLE(27, 3) + 1
		return { width, height }
	}
	return null
}

/**
 * SVG size, preferring `viewBox` over `width`/`height`.
 *
 * `width="100%"` is common and meaningless as an intrinsic size, whereas the
 * viewBox always carries the real proportions — and proportions are what a
 * placement decision needs.
 */
export function probeSvg(source: string): Dimensions | null {
	const openingTag = /<svg\b[^>]*>/i.exec(source)?.[0]
	if (!openingTag) return null

	const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(openingTag)?.[1]
	if (viewBox) {
		const parts = viewBox
			.trim()
			.split(/[\s,]+/)
			.map(Number)
		if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
			return { width: parts[2], height: parts[3] }
		}
	}

	const width = numericAttribute(openingTag, "width")
	const height = numericAttribute(openingTag, "height")
	return width && height ? { width, height } : null
}

/** Reads an attribute as px, ignoring percentages and other relative units. */
function numericAttribute(tag: string, name: string): number | null {
	const raw = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1]
	if (!raw || raw.includes("%")) return null
	const value = Number.parseFloat(raw)
	return Number.isFinite(value) && value > 0 ? value : null
}
