/**
 * A small, real-looking app whose look is decided in three different places:
 * a Tailwind @theme block (brand #4f46e5, corners 0.5rem), next/font (Inter),
 * and plain CSS (a light page). Used by every test of "Use what my app already
 * has", so they all read the same app.
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as path from "path"

export const SAMPLE_APP_FILES: Record<string, string> = {
	"package.json": JSON.stringify(
		{
			name: "acme-dashboard",
			private: true,
			dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
			devDependencies: { tailwindcss: "4.0.0" },
		},
		null,
		2,
	),
	"app/globals.css": `@import "tailwindcss";

@theme {
  --color-primary: #4f46e5;
  --color-primary-dark: #3730a3;
  --font-sans: "Inter", ui-sans-serif, system-ui;
  --radius-lg: 0.5rem;
}

body {
  background: #f8fafc;
  color: #0f172a;
}
`,
	"app/layout.tsx": `import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
`,
	"app/orders/page.tsx": `const orders = await fetch("/api/orders").then((r) => r.json())

export default function Orders() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold text-slate-900">All orders</h1>
      <table className="mt-6 w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th>Order</th><th>Customer</th><th>Total</th></tr></thead>
        <tbody>{orders.map((o: any) => <tr key={o.id}><td>{o.id}</td><td>{o.customer}</td><td>{o.total}</td></tr>)}</tbody>
      </table>
    </main>
  )
}
`,
	"app/settings/page.tsx": `export default function Settings() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
      <label className="mt-6 block text-sm text-slate-600">Store name<input className="mt-1 block w-full rounded-lg border px-3 py-2" defaultValue="Acme" /></label>
      <button className="mt-6 rounded-lg bg-primary px-4 py-2 text-white">Save</button>
    </main>
  )
}
`,
	"app/page.tsx": `export default function Home() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-3xl font-semibold text-slate-900">Orders</h1>
      <p className="mt-2 text-sm text-slate-500">Everything shipped this week.</p>
      <button className="mt-6 rounded-lg bg-primary px-4 py-2 text-white shadow-none">New order</button>
    </main>
  )
}
`,
}

/** Writes the sample app into `dir` and commits it, as a real project would be. */
export async function writeSampleApp(dir: string): Promise<void> {
	for (const [relative, content] of Object.entries(SAMPLE_APP_FILES)) {
		const full = path.join(dir, relative)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content)
	}
	child_process.execSync("git init -q && git add -A && git -c user.email=p@l -c user.name=p commit -qm init --no-verify", {
		cwd: dir,
		stdio: "ignore",
	})
}
