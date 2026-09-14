import { ArrowLeftIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { DesignServiceClient } from "@/services/design-client"
import { WIZARD_STEPS } from "./data-steps"
import { DEFAULT_TOKENS, draftFromSaved, type FoundationTokensDraft, mergeDraftOverSaved } from "./draft"
import { TokenPreview } from "./preview/TokenPreview"
import { ColorStep } from "./steps/ColorStep"
import { DepthStep } from "./steps/DepthStep"
import { RadiusStep } from "./steps/RadiusStep"
import { ReviewStep } from "./steps/ReviewStep"
import { SpacingStep } from "./steps/SpacingStep"
import { TypographyStep } from "./steps/TypographyStep"
import { VibeStep } from "./steps/VibeStep"

// The steps import the draft type from here; the shape itself lives in draft.ts.
export type { FoundationTokensDraft } from "./draft"

type Props = {
	onDone: () => void
	/** Entry-flow prefill for a project described before choosing manual. */
	initialDescription?: string
	/** Open on a specific step — the DS view's per-section edit jumps. */
	initialStep?: number
}

export function TokenWizard({ onDone, initialDescription, initialStep }: Props) {
	const [step, setStep] = useState(initialStep ?? 0)
	const [tokens, setTokens] = useState<FoundationTokensDraft>(DEFAULT_TOKENS)
	const [saving, setSaving] = useState(false)
	const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle")
	const [saveError, setSaveError] = useState("")
	const [loaded, setLoaded] = useState(false)
	const [hasExistingTokens, setHasExistingTokens] = useState(false)
	// The file as loaded, kept whole. The draft above holds only what the steps
	// edit; saving merges the draft OVER this, so fields the editor does not
	// know about (`meta`, on-colours, motion, a future group) survive the
	// round-trip instead of being silently dropped — `color.surface` was lost
	// exactly this way before.
	const [savedRaw, setSavedRaw] = useState<Record<string, any> | null>(null)

	useEffect(() => {
		let cancelled = false
		DesignServiceClient.getFoundationTokens({})
			.then((response) => {
				if (cancelled) return
				if (response.tokensJson && response.tokensJson !== "null") {
					try {
						const saved = JSON.parse(response.tokensJson)
						setSavedRaw(saved)
						const draft = draftFromSaved(saved)
						// The entry flow's description wins over the stored vibe: on a
						// re-run the user just typed it, deliberately.
						if (initialDescription) draft.vibe = { ...draft.vibe, description: initialDescription }
						setTokens(draft)
						setHasExistingTokens(true)
					} catch {
						// ignore parse errors, use defaults
					}
				}
			})
			.catch(() => {
				// no existing tokens, use defaults
			})
			.finally(() => {
				if (!cancelled) setLoaded(true)
			})
		return () => {
			cancelled = true
		}
	}, [])

	useEffect(() => {
		// No file yet: the entry flow's description is all there is to prefill.
		if (initialDescription && loaded && !hasExistingTokens) {
			setTokens((prev) => ({ ...prev, vibe: { ...prev.vibe, description: initialDescription } }))
		}
	}, [initialDescription, loaded, hasExistingTokens])

	const handleNext = useCallback(() => {
		if (step < WIZARD_STEPS.length - 1) {
			setStep(step + 1)
		}
	}, [step])

	const handleBack = useCallback(() => {
		if (step > 0) {
			setStep(step - 1)
		}
	}, [step])

	const handleSave = useCallback(async () => {
		setSaving(true)
		setSaveStatus("idle")
		setSaveError("")
		try {
			await DesignServiceClient.updateFoundationTokens({
				tokensJson: JSON.stringify(mergeDraftOverSaved(savedRaw, tokens)),
			})
			setSaveStatus("success")
			setTimeout(() => onDone(), 1200)
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to save tokens"
			console.error("Failed to save tokens:", e)
			setSaveStatus("error")
			setSaveError(msg)
		} finally {
			setSaving(false)
		}
	}, [tokens, savedRaw, onDone])

	const handleEditStep = useCallback((targetStep: number) => {
		setStep(targetStep)
	}, [])

	const currentStep = WIZARD_STEPS[step]
	const isLastStep = step === WIZARD_STEPS.length - 1

	if (!loaded) {
		return (
			<div className="flex flex-col h-full items-center justify-center">
				<span className="text-sm text-muted-foreground">Loading tokens...</span>
			</div>
		)
	}

	return (
		<div className="flex flex-col h-full" data-testid="token-editor">
			<div className="flex items-center gap-2 px-4 py-3 border-b border-input">
				<button className="p-1 rounded hover:bg-input-background text-foreground" onClick={onDone}>
					<ArrowLeftIcon size={16} />
				</button>
				<h2 className="text-sm font-medium text-foreground">Token Configuration</h2>
			</div>

			<div className="flex items-center gap-1 px-4 py-2 border-b border-input">
				{WIZARD_STEPS.map((s, i) => {
					const canNavigate = hasExistingTokens || i <= step
					return (
						<button
							className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
								i === step
									? "bg-button-background text-button-foreground"
									: canNavigate
										? "text-button-background hover:underline"
										: "text-muted-foreground"
							}`}
							disabled={!canNavigate}
							key={s.id}
							onClick={() => canNavigate && setStep(i)}>
							{s.title}
						</button>
					)
				})}
			</div>

			<div className="flex-1 overflow-y-auto px-4 py-4">
				<div className="mb-4">
					<h3 className="text-sm font-medium text-foreground">
						Step {step + 1}: {currentStep.title}
					</h3>
					<p className="text-xs text-muted-foreground mt-0.5">{currentStep.description}</p>
				</div>

				{step === 0 && <VibeStep onChange={setTokens} tokens={tokens} />}
				{step === 1 && <ColorStep onChange={setTokens} tokens={tokens} />}
				{step === 2 && <TypographyStep onChange={setTokens} tokens={tokens} />}
				{step === 3 && <SpacingStep onChange={setTokens} tokens={tokens} />}
				{step === 4 && <RadiusStep onChange={setTokens} tokens={tokens} />}
				{step === 5 && <DepthStep onChange={setTokens} tokens={tokens} />}
				{step === 6 && <ReviewStep onEditStep={handleEditStep} tokens={tokens} />}

				{/* Live preview */}
				{step < 6 && (
					<div className="mt-6 pt-4 border-t border-input">
						<h4 className="text-xs font-medium text-muted-foreground mb-2">Live Preview</h4>
						<TokenPreview tokens={tokens} />
					</div>
				)}
			</div>

			<div className="flex flex-col gap-2 px-4 py-3 border-t border-input">
				{saveStatus === "success" && (
					<div
						className="text-xs text-center py-1.5 px-3 rounded-md"
						style={{ backgroundColor: "var(--vscode-testing-iconPassed, #22c55e)", color: "white" }}>
						Tokens saved successfully
					</div>
				)}
				{saveStatus === "error" && (
					<div
						className="text-xs text-center py-1.5 px-3 rounded-md"
						style={{ backgroundColor: "var(--vscode-testing-iconFailed, #ef4444)", color: "white" }}>
						{saveError || "Failed to save tokens"}
					</div>
				)}
				<div className="flex items-center justify-between">
					<Button disabled={step === 0} onClick={handleBack} variant="secondary">
						Back
					</Button>
					{isLastStep ? (
						<Button disabled={saving || saveStatus === "success"} onClick={handleSave}>
							{saving ? "Saving..." : saveStatus === "success" ? "Saved!" : "Save Tokens"}
						</Button>
					) : (
						<Button onClick={handleNext}>Next</Button>
					)}
				</div>
			</div>
		</div>
	)
}
