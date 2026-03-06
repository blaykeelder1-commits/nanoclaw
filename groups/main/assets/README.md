# Assets Directory

Store product photos, PDFs, brochures, and video thumbnails here for use in email campaigns and outreach.

## File Naming Convention

- Product photos: `{product-type}-{descriptor}.jpg` (e.g., `coffee-machine-hero.jpg`, `vending-office-lobby.jpg`)
- Before/after shots: `casestudy-{client}-before.jpg`, `casestudy-{client}-after.jpg`
- PDFs and brochures: `{product-type}-brochure.pdf` (e.g., `coffee-brochure.pdf`)
- Logos: `snak-logo-{variant}.png` (e.g., `snak-logo-dark.png`, `snak-logo-white.png`)

## Usage

Reference these files via `--attachments` or `--inline-images` flags in the send-email tool. For inline images used in HTML templates, the filename must match the `cid:` reference in the template (e.g., `hero-image.jpg` for `cid:hero-image.jpg`).
