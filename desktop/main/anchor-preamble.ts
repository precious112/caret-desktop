/**
 * What the style anchor is allowed to contribute.
 *
 * Written as a hard split because the failure it fixes was total: the previous
 * wording ("this must look shot in the same session") produced a second copy of
 * the reference photograph, and every framing decision the user had just made
 * in the clarify questions was silently discarded. The description has to be
 * named as the authority on content, in the same breath as the reference is
 * named as the authority on light.
 */
export const ANCHOR_PREAMBLE = [
	"The attached image is a COLOUR AND LIGHT REFERENCE ONLY — an earlier photograph from the same campaign.",
	"Take from it exactly three things: the quality and direction of the light, the colour grade, and the black level.",
	"Take NOTHING else from it. Its composition, camera distance, crop, subject size, subject position and camera angle are not yours to copy.",
	"Everything about what is photographed and how it is framed comes only from the description below, and where the two disagree the description wins.",
	"This is a different photograph from the same shoot, not another version of the reference.",
].join(" ")
