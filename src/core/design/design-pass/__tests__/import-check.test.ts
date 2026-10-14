import { missingImports } from "../import-check"

const marquee = { importPath: "../../components/catalog/magicui/marquee", namedExport: "Marquee", section: "hero", job: "x" }
const map = { importPath: "../../components/catalog/aceternity/world-map", section: "routes", job: "y" }

describe("design pass · import check", () => {
	it("finds a chosen component the written page never imports", () => {
		const page = 'import { Marquee } from "../../components/catalog/magicui/marquee"\nexport default function Page() {}'
		missingImports([marquee, map], [page]).should.eql([map])
	})

	it("accepts the import with an extension, or in any written page", () => {
		const one = "import WorldMap from '../../components/catalog/aceternity/world-map.tsx'"
		const two = 'import { Marquee } from "../../components/catalog/magicui/marquee"'
		missingImports([marquee, map], [one, two]).should.eql([])
	})

	it("does not count a different component whose name starts the same", () => {
		missingImports([marquee], ['import X from "../../components/catalog/magicui/marquee-3d"']).should.eql([marquee])
	})
})
