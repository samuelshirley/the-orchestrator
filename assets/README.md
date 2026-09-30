# Assets

`patches-avatar.png` (512x512) is Patches, the dog the project manager is named after, cut out of a photo
by the person who made The Orchestrator and placed on a purple background. It is the plugin logo
(`bb.branding.logo.light`).

- Cutout: macOS Vision foreground mask (`VNGenerateForegroundInstanceMaskRequest`),
  edge eroded 2px and colour-decontaminated so no trail dirt fringes the fur.
- Background: radial fade `#5F3A7B` (centre) to `#54326F` (corners).

`patchesAvatar.ts` is the same image at 96x96 as a data URL for the chat
header (28px; the app bundler has no `.png` loader). Regenerate it whenever
the PNG changes.
