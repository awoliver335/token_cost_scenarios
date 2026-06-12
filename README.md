# Token Cost Estimator

This project estimates token counts and input-token costs for files sent to different AI APIs or models.

Drop files into one folder, enter API/model names and prices in the notebook, and run the notebook. The result is a set of tables with token counts and estimated costs.

## What You Need

- Python 3.11 or newer
- Jupyter Notebook or JupyterLab

Install the required Python packages once:

```powershell
python -m pip install -r requirements.txt
```

## How To Use It

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

The notebook currently reads:

- Markdown files: `.md`, `.markdown`
- Text files: `.txt`, `.text`
- PDF files: `.pdf`

Other file types are ignored.

## Understanding The Results

The notebook shows two tables:

- `model_summary_df`: total estimated cost by API/model
- `file_costs_df`: file-by-file token counts, extraction status, and estimated costs

Important columns:

- `input_tokens`: estimated number of input tokens in the extracted text
- `status`: whether the file was read successfully
- `notes`: extra details, especially for PDFs
- `cost_usd_*`: estimated cost for each API/model

## A Note About PDFs

PDFs can be tricky. Some PDFs contain normal selectable text, and those should work well.

Scanned PDFs or image-only PDFs usually do not contain extractable text. Those files stay in the results with `status = "no_text"` and a note explaining that OCR would be needed.

## Privacy And Git

Files dropped into `files_to_estimate` are ignored by git by default. That helps avoid accidentally committing private documents.

## Troubleshooting

If the notebook says no files were found:

- Make sure your files are inside `files_to_estimate`.
- Make sure they are `.md`, `.markdown`, `.txt`, `.text`, or `.pdf`.
- Rerun the estimate cell after adding files.

If imports fail:

```powershell
python -m pip install -r requirements.txt
```
