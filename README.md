# Token Cost Estimator

Estimate input-token counts and costs for pasted text, Markdown/text files, and PDFs with selectable text.

This repository now has two ways to use the estimator:

- A browser-only GitHub Pages app for quick estimates.
- The original Python notebook workflow for local folder-based estimates.

## GitHub Pages App

The static app is built with Vite and TypeScript. It runs entirely in the browser: uploaded files are read locally in the page session and are not sent to a backend.

Local development:

```powershell
npm install
npm run dev
```

Production build:

```powershell
npm run build
```

Preview the production build:

```powershell
npm run preview
```

The Vite base path is configured for this project page:

```text
https://awoliver335.github.io/token_cost_scenarios/
```

## Deploying To GitHub Pages

The workflow at `.github/workflows/pages.yml` builds the app and deploys the `dist` artifact when changes are pushed to `main`.

In the GitHub repository settings:

1. Open **Settings > Pages**.
2. Set **Source** to **GitHub Actions**.
3. Push to `main` or run the workflow manually.

## Browser App Features

- Paste text directly into the page.
- Upload `.txt`, `.text`, `.md`, `.markdown`, and `.pdf` files.
- Extract text from PDFs that contain selectable text.
- Edit model/API names and input-token prices.
- See total estimated cost by model and source-level details.
- Download results as CSV.

The browser app uses the `o200k_base` tokenizer through `js-tiktoken`, matching the Python helper default.

## Python Notebook Workflow

The Python workflow is still available for local folder-based analysis.

### What You Need

- Python 3.11 or newer
- Jupyter Notebook or JupyterLab

Install the required Python packages once:

```powershell
python -m pip install -r requirements.txt
```

### How To Use It

1. Put files into the `files_to_estimate` folder.
2. Open `token_cost_estimator.ipynb`.
3. Run the first setup cell.
4. Edit the `API_COSTS` list in the notebook.
5. Run the estimate cell.

The API cost rows look like this:

```python
API_COSTS = [
    ("Example API / Model", 2.50),
    ("Lower-cost API / Model", 0.75),
]
```

The number is the cost in US dollars per 1 million input tokens.

## Supported Files

Both workflows read:

- Markdown files: `.md`, `.markdown`
- Text files: `.txt`, `.text`
- PDF files: `.pdf`

Other file types are ignored by the Python workflow and marked unsupported in the browser app.

## Understanding The Results

The estimates include:

- `input_tokens`: estimated number of input tokens in extracted text
- `status`: whether the source was read successfully
- `notes`: extra details, especially for PDFs
- `cost_usd_*` or per-model cost columns: estimated cost for each API/model

PDFs can be tricky. PDFs with selectable text should work well. Scanned or image-only PDFs usually do not contain extractable text and need OCR, which is out of scope for this project.

## Privacy And Git

Files dropped into `files_to_estimate` are ignored by git by default. That helps avoid accidentally committing private documents.

The GitHub Pages app does not upload files to a server. It processes selected files in the browser session.
