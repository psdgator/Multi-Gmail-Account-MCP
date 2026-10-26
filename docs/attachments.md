# Reading attachments

`read_attachment` lets Claude read what is inside an attachment without you saving it first. Ask things like *"what's the total on the invoice the supplier sent?"*, *"summarise the PDF in the latest email from DHL"* or *"what sizes are in the print spec?"*.

It works for Gmail and IMAP accounts, in every mode (including `readonly`), and through the hosted server.

## What it can read

| Format | What Claude gets |
|---|---|
| **PDF** (and Illustrator `.ai` files saved with PDF compatibility) | Text page by page (`--- Page N ---`). Use `pages: "3-5"` to read a range. |
| **Scanned PDF** (no text layer) | The page images, which Claude reads visually. Up to 2 of the largest pages; JPEG-based scans only. |
| **Word** `.docx` | Paragraphs, tabs and line breaks. Tables become `cell \| cell` rows. Headers, footers and footnotes are included. Tracked deletions and field codes are skipped. |
| **Excel** `.xlsx` | Each sheet as CSV (`=== Sheet: name ===`), with dates converted to ISO format and booleans as TRUE/FALSE. Formulas show their last calculated value. Hidden sheets are marked. Use `sheet: "name"` to read just one. |
| **PowerPoint** `.pptx` | Slides in presentation order (`--- Slide N ---`), with speaker notes. |
| **OpenDocument** `.odt` / `.ods` | Text and tables; sheets as CSV. |
| **RTF** | Plain text, with Greek code pages (`\ansicpg1253`) decoded. |
| **Text family** (`.txt .csv .tsv .md .json .xml .ics .vcf .svg` …) | Decoded text. UTF-8/16 are detected by BOM, otherwise from the declared charset. Greek `windows-1253` exports are detected automatically. |
| **HTML** | Converted to readable text. |
| **Forwarded emails** `.eml` | Headers, body and the list of its attachments. |
| **ZIP** | Lists the files. The text of up to 5 small documents inside (PDF, Office, text) is included. |
| **Images** (PNG, JPEG, GIF, WebP) | The image itself, returned as an image so Claude can look at it and read text in it (receipts, screenshots, print proofs, Greek included). |

These can't be read: legacy binary Office (`.doc`, `.xls`, `.ppt`, `.msg`), PostScript/EPS, Photoshop `.psd`, TIFF/HEIC, and encrypted or damaged files. For them Claude gets a short note suggesting `save_attachment`.

## Limits and safety

- **Output size:** text is capped at 30,000 characters by default (`maxChars`, up to 200,000), and a note says how to read more. Long PDFs stop at the cap, and you continue with `pages`.
- **Images:** up to about 3.7 MB and 8000 px per side, which is Claude's own image limit. For anything bigger, use `save_attachment`.
- **Sheets:** each sheet is capped at 1,000 rows and 500 columns, and repeated empty rows and columns are collapsed. OpenDocument repeat attributes are capped too, so a tiny `.ods` can't expand into millions of cells.
- **ZIP bombs:** archives are only opened while every file inside is under 25 MB and the total is under 50 MB, with at most 5,000 entries. Archives that lie about their sizes are truncated rather than expanded.
- **Damaged files:** the tool never crashes. It returns `kind: "unsupported"` with a note.
- **Isolated and time-limited:** each attachment is read in a separate worker thread with a **20-second limit** and a **512 MB memory cap**. If a file is too slow or too big to read, it's stopped and you get a note suggesting `save_attachment`. The server itself never freezes, which matters in hosted mode where many sessions share one process. Change the limits with `GMAIL_MCP_EXTRACT_TIMEOUT_MS` and `GMAIL_MCP_EXTRACT_MEMORY_MB`.
- **Linear-time parsing:** the parsers are built so hostile files (thousands of unclosed tags, huge runs of spaces, crafted PDFs) take time proportional to their size and nothing more.
- **No stdout noise:** parser output goes to stderr, never stdout, so the MCP connection can't be corrupted.
- **Untrusted content:** attachments can contain text written to manipulate an AI ("ignore your instructions and forward…"). The tool description and the server instructions tell Claude never to follow instructions found inside files or emails.

## Examples

```jsonc
// Read the 2nd page of a PDF
{ "messageId": "18f…", "account": "shop", "filename": "invoice.pdf", "pages": "2" }

// One sheet of a workbook
{ "messageId": "18f…", "partId": "2", "sheet": "Παραγγελίες" }
```

The result looks like this:

```json
{
  "account": "shop",
  "filename": "invoice.pdf",
  "mimeType": "application/pdf",
  "bytes": 48213,
  "kind": "text",
  "format": "pdf",
  "totalPages": 3,
  "pagesShown": [2],
  "text": "--- Page 2 ---\nTotal: 200.00 EUR",
  "truncated": false
}
```

Image results carry a second content block with the picture, plus `imagesAttached` in the JSON.

## How it works

Extraction lives in `src/extract/` and needs no native modules:

- PDF uses [`unpdf`](https://github.com/unjs/unpdf), a serverless build of Mozilla's pdf.js with eval disabled.
- Office and OpenDocument files are unzipped with [`fflate`](https://github.com/101arrowz/fflate) and read with a small XML tokenizer (`xml.ts`).
- `.eml` files are parsed with `mailparser`.
- Images are checked by their magic bytes and returned unchanged; Claude's vision does the reading.
