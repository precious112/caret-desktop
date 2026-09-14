/** Vite turns image imports into URLs; TypeScript needs telling. */
declare module "*.png" {
	const url: string
	export default url
}
declare module "*.svg" {
	const url: string
	export default url
}
