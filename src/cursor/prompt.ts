export function buildPresetPrompt(userPrompt: string, presetPrompt?: string): string {
  const instructions = presetPrompt?.trim()
  if (!instructions) return userPrompt
  return `[Bot Instructions]\n${instructions}\n\n[User Message]\n${userPrompt}`
}
