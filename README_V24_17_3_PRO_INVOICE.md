# ITTR v24.17.3 — Professional Invoice PDF + Note Preservation

## Corrected
- Downloading a PDF now saves the current invoice draft first.
- Customer notes typed into the invoice are persisted before PDF generation.
- Email and payment-link actions also persist current invoice edits first.
- The PDF prints the exact saved customer note; it no longer substitutes a generic thank-you message.
- Rebuilt invoice table geometry with a safer right margin so Amount values do not clip.
- Labor remains the primary row and parts remain nested directly beneath that labor.
- Old hidden job/service names are not printed.
- Notes and totals panels dynamically accommodate longer customer notes, including warranty language.

## Validation
- npm run check
- node --check server.js
