from __future__ import annotations

import fnmatch
import math
import re
from pathlib import Path
from typing import Iterable

import pandas as pd
import tiktoken
from pypdf import PdfReader


DEFAULT_DROP_FOLDER_NAME = "files_to_estimate"
DEFAULT_SUPPORTED_EXTENSIONS = {".md", ".markdown", ".txt", ".text", ".pdf"}
DEFAULT_EXCLUDE_GLOBS = (
    ".git/*",
    "**/.git/*",
    ".ipynb_checkpoints/*",
    "**/.ipynb_checkpoints/*",
)
DEFAULT_TOKENIZER_ENCODING = "o200k_base"


def default_drop_folder(base_path: str | Path | None = None) -> Path:
    """Return the folder where users should drop files for estimation."""
    base = Path.cwd() if base_path is None else Path(base_path)
    return base / DEFAULT_DROP_FOLDER_NAME


def normalize_scenario_name(name: str) -> str:
    """Return a stable suffix for dataframe cost columns."""
    normalized = re.sub(r"[^0-9a-zA-Z]+", "_", str(name).strip().lower()).strip("_")
    return normalized or "scenario"


def unique_column_name(base_name: str, used_names: set[str]) -> str:
    candidate = base_name
    index = 2
    while candidate in used_names:
        candidate = f"{base_name}_{index}"
        index += 1
    used_names.add(candidate)
    return candidate


def relative_posix_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def matches_any_glob(file_name: str, relative_path: str, patterns: Iterable[str]) -> bool:
    return any(
        fnmatch.fnmatch(file_name, pattern) or fnmatch.fnmatch(relative_path, pattern)
        for pattern in patterns
    )


def iter_candidate_files(
    folder_path: str | Path,
    recursive: bool = True,
    supported_extensions: Iterable[str] | None = None,
    include_globs: Iterable[str] | None = None,
    exclude_globs: Iterable[str] | None = None,
) -> list[Path]:
    folder = Path(folder_path).expanduser().resolve()
    supported = {ext.lower() for ext in (supported_extensions or DEFAULT_SUPPORTED_EXTENSIONS)}
    include = list(include_globs or ["*"])
    exclude = list(exclude_globs or DEFAULT_EXCLUDE_GLOBS)

    if not folder.exists():
        raise FileNotFoundError(f"Folder does not exist: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"Folder path must be a folder: {folder}")

    search_pattern = "**/*" if recursive else "*"
    files = []

    for path in folder.glob(search_pattern):
        if not path.is_file():
            continue
        if path.suffix.lower() not in supported:
            continue

        relative_path = relative_posix_path(path, folder)
        file_name = path.name
        if not matches_any_glob(file_name, relative_path, include):
            continue
        if matches_any_glob(file_name, relative_path, exclude):
            continue

        files.append(path)

    return sorted(files, key=lambda item: relative_posix_path(item, folder).lower())


def read_text_file(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8", errors="replace")
    notes = []

    if "\ufffd" in text:
        notes.append("Some undecodable bytes were replaced while reading as UTF-8")
    if not text.strip():
        notes.append("No text content found")

    return {
        "text": text,
        "pages": math.nan,
        "status": "ok" if text.strip() else "no_text",
        "notes": "; ".join(notes),
    }


def read_pdf_file(path: Path) -> dict[str, object]:
    notes = []
    reader = PdfReader(str(path))

    if reader.is_encrypted:
        decrypt_result = reader.decrypt("")
        if not decrypt_result:
            return {
                "text": "",
                "pages": math.nan,
                "status": "error",
                "notes": "PDF is encrypted and could not be opened with an empty password",
            }
        notes.append("PDF was encrypted and opened with an empty password")

    page_count = len(reader.pages)
    page_texts = []
    empty_pages = 0

    for page in reader.pages:
        page_text = page.extract_text() or ""
        if not page_text.strip():
            empty_pages += 1
        page_texts.append(page_text)

    text = "\n\n".join(page_texts)
    if page_count == 0:
        notes.append("PDF has no pages")
    elif empty_pages:
        notes.append(f"{empty_pages} of {page_count} page(s) had no extractable text")

    if not text.strip():
        notes.append("No extractable text found; scanned/image-only PDFs need OCR")
        status = "no_text"
    else:
        status = "ok"

    return {
        "text": text,
        "pages": page_count,
        "status": status,
        "notes": "; ".join(notes),
    }


def extract_file_text(path: str | Path) -> dict[str, object]:
    path = Path(path)
    try:
        if path.suffix.lower() == ".pdf":
            return read_pdf_file(path)
        return read_text_file(path)
    except Exception as exc:
        return {
            "text": "",
            "pages": math.nan,
            "status": "error",
            "notes": f"{type(exc).__name__}: {exc}",
        }


def load_encoding(encoding_name: str = DEFAULT_TOKENIZER_ENCODING):
    try:
        return tiktoken.get_encoding(encoding_name)
    except ValueError as exc:
        raise ValueError(
            f"Unknown tokenizer encoding '{encoding_name}'. Try 'o200k_base' or 'cl100k_base'."
        ) from exc


def count_input_tokens(text: str, encoding) -> int:
    if not text:
        return 0
    return len(encoding.encode(text))


def normalize_api_costs(api_costs: Iterable[tuple[str, float] | dict[str, object]]) -> list[dict[str, object]]:
    if not api_costs:
        raise ValueError("API_COSTS must contain at least one row.")

    normalized_costs = []
    used_columns: set[str] = set()

    for index, item in enumerate(api_costs, start=1):
        if isinstance(item, dict):
            name = item.get("name", item.get("api_name"))
            cost = item.get("cost_per_1m_input_tokens", item.get("cost"))
        else:
            try:
                name, cost = item
            except ValueError as exc:
                raise ValueError(
                    f"API_COSTS row #{index} must contain exactly two values: name and cost."
                ) from exc

        name = str(name).strip()
        if not name:
            raise ValueError(f"API_COSTS row #{index} has an empty API/model name.")

        try:
            cost_per_1m = float(cost)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"API_COSTS row #{index} for '{name}' has a cost that is not a number."
            ) from exc

        if cost_per_1m < 0:
            raise ValueError(f"API_COSTS row #{index} for '{name}' has a negative cost.")

        column_base = f"cost_usd_{normalize_scenario_name(name)}"
        cost_column = unique_column_name(column_base, used_columns)
        normalized_costs.append(
            {
                "api_name": name,
                "cost_per_1m_input_tokens": cost_per_1m,
                "cost_column": cost_column,
            }
        )

    return normalized_costs


def estimate_file(path: str | Path, root: str | Path, encoding) -> dict[str, object]:
    path = Path(path)
    root = Path(root)
    extraction = extract_file_text(path)
    text = str(extraction.pop("text"))

    return {
        "file_path": str(path.resolve()),
        "relative_path": relative_posix_path(path, root),
        "file_name": path.name,
        "extension": path.suffix.lower(),
        "bytes": path.stat().st_size,
        "pages": extraction["pages"],
        "extracted_chars": len(text),
        "input_tokens": count_input_tokens(text, encoding),
        "status": extraction["status"],
        "notes": extraction["notes"],
    }


def build_file_costs_dataframe(
    folder_path: str | Path,
    api_costs: Iterable[tuple[str, float] | dict[str, object]],
    recursive: bool = True,
    tokenizer_encoding: str = DEFAULT_TOKENIZER_ENCODING,
    supported_extensions: Iterable[str] | None = None,
    include_globs: Iterable[str] | None = None,
    exclude_globs: Iterable[str] | None = None,
) -> tuple[pd.DataFrame, list[dict[str, object]]]:
    root = Path(folder_path).expanduser().resolve()
    scenarios = normalize_api_costs(api_costs)
    encoding = load_encoding(tokenizer_encoding)
    files = iter_candidate_files(
        root,
        recursive=recursive,
        supported_extensions=supported_extensions,
        include_globs=include_globs,
        exclude_globs=exclude_globs,
    )
    rows = [estimate_file(path, root, encoding) for path in files]

    columns = [
        "file_path",
        "relative_path",
        "file_name",
        "extension",
        "bytes",
        "pages",
        "extracted_chars",
        "input_tokens",
        "status",
        "notes",
    ]
    df = pd.DataFrame(rows, columns=columns)

    if df.empty:
        df = pd.DataFrame(columns=columns)
        df["input_tokens"] = pd.Series(dtype="int64")

    for scenario in scenarios:
        df[str(scenario["cost_column"])] = (
            df["input_tokens"] / 1_000_000
        ) * float(scenario["cost_per_1m_input_tokens"])

    return df, scenarios


def build_model_summary_dataframe(
    file_costs_df: pd.DataFrame,
    scenarios: Iterable[dict[str, object]],
) -> pd.DataFrame:
    total_tokens = int(file_costs_df["input_tokens"].sum()) if "input_tokens" in file_costs_df else 0
    file_count = int(len(file_costs_df))
    error_count = int((file_costs_df["status"] == "error").sum()) if "status" in file_costs_df else 0
    no_text_count = int((file_costs_df["status"] == "no_text").sum()) if "status" in file_costs_df else 0

    rows = []
    for scenario in scenarios:
        cost_per_1m = float(scenario["cost_per_1m_input_tokens"])
        rows.append(
            {
                "api_name": scenario["api_name"],
                "cost_per_1m_input_tokens": cost_per_1m,
                "total_input_tokens": total_tokens,
                "estimated_cost_usd": (total_tokens / 1_000_000) * cost_per_1m,
                "files_counted": file_count,
                "files_without_text": no_text_count,
                "files_with_errors": error_count,
                "cost_column": scenario["cost_column"],
            }
        )

    return pd.DataFrame(rows)


def estimate_costs(
    folder_path: str | Path | None = None,
    api_costs: Iterable[tuple[str, float] | dict[str, object]] | None = None,
    recursive: bool = True,
    tokenizer_encoding: str = DEFAULT_TOKENIZER_ENCODING,
    supported_extensions: Iterable[str] | None = None,
    include_globs: Iterable[str] | None = None,
    exclude_globs: Iterable[str] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    if api_costs is None:
        raise ValueError("Pass API costs as rows like [('Model name', 2.50)].")

    folder = default_drop_folder() if folder_path is None else Path(folder_path)
    folder.mkdir(parents=True, exist_ok=True)

    file_costs_df, scenarios = build_file_costs_dataframe(
        folder,
        api_costs=api_costs,
        recursive=recursive,
        tokenizer_encoding=tokenizer_encoding,
        supported_extensions=supported_extensions,
        include_globs=include_globs,
        exclude_globs=exclude_globs,
    )
    model_summary_df = build_model_summary_dataframe(file_costs_df, scenarios)
    file_costs_df.attrs["cost_column_labels"] = {
        str(scenario["cost_column"]): f"Cost: {scenario['api_name']}" for scenario in scenarios
    }
    return file_costs_df, model_summary_df


def _hide_index(styler):
    try:
        return styler.hide(axis="index")
    except TypeError:
        return styler.hide_index()


def _friendly_cost_column_label(column: str, labels: dict[str, str] | None = None) -> str:
    if labels and column in labels:
        return labels[column]
    name = column.removeprefix("cost_usd_").replace("_", " ").strip().title()
    return f"Cost: {name}" if name else "Cost"


def style_file_costs(file_costs_df: pd.DataFrame, precision: int = 6):
    display_columns = [
        "file_name",
        "bytes",
        "pages",
        "extracted_chars",
        "input_tokens",
    ]
    cost_columns = [column for column in file_costs_df.columns if column.startswith("cost_usd_")]
    display_df = file_costs_df[[column for column in display_columns + cost_columns if column in file_costs_df]]
    cost_labels = file_costs_df.attrs.get("cost_column_labels", {})
    display_df = display_df.rename(
        columns={
            "file_name": "File",
            "bytes": "Bytes",
            "pages": "Pages",
            "extracted_chars": "Extracted characters",
            "input_tokens": "Input tokens",
            **{
                column: _friendly_cost_column_label(column, cost_labels)
                for column in cost_columns
            },
        }
    )

    formatters = {
        "Bytes": "{:,.0f}",
        "Extracted characters": "{:,.0f}",
        "Input tokens": "{:,.0f}",
    }
    for column in display_df.columns:
        if column.startswith("Cost: "):
            formatters[column] = f"${{:.{precision}f}}"
    return _hide_index(display_df.style.format(formatters, na_rep=""))


def style_model_summary(model_summary_df: pd.DataFrame, precision: int = 6):
    display_columns = [
        "api_name",
        "cost_per_1m_input_tokens",
        "total_input_tokens",
        "estimated_cost_usd",
        "files_counted",
        "files_without_text",
        "files_with_errors",
    ]
    display_df = model_summary_df[[column for column in display_columns if column in model_summary_df]]
    display_df = display_df.rename(
        columns={
            "api_name": "API / model",
            "cost_per_1m_input_tokens": "Cost per 1M input tokens",
            "total_input_tokens": "Total input tokens",
            "estimated_cost_usd": "Estimated cost",
            "files_counted": "Files counted",
            "files_without_text": "Files without text",
            "files_with_errors": "Files with errors",
        }
    )

    formatters = {
        "Cost per 1M input tokens": f"${{:.{precision}f}}",
        "Total input tokens": "{:,.0f}",
        "Estimated cost": f"${{:.{precision}f}}",
        "Files counted": "{:,.0f}",
        "Files without text": "{:,.0f}",
        "Files with errors": "{:,.0f}",
    }
    return _hide_index(display_df.style.format(formatters, na_rep=""))
