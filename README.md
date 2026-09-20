# SIF Safety Intelligence Platform

An enterprise-grade safety report analysis and decision-support platform engineered for **Oil India Limited (OIL)** Health, Safety, and Environment (HSE) divisions to process Unsafe Act, Unsafe Condition, and Near-Miss reports, detect potential Serious Injury and Fatality (SIF) precursors, calculate transparent risk rankings, and streamline human safety review.

---

## 1. Project Overview

The **SIF Safety Intelligence Platform** transforms high-volume safety reporting from an overwhelming administrative burden into an actionable, prioritized intelligence workflow. In upstream exploration, drilling, production, and refining environments, safety officers receive hundreds of field reports each month. Critical warning signs (such as vapor weeping near hot work, unhooked fall-arrest systems, or locked-in trapped hydraulic pressure) can easily be buried beneath minor housekeeping observations.

This platform automatically extracts safety factors, identifies potential SIF precursor indicators using an LLM/NLP pipeline, applies a transparent and auditable risk scoring engine, prioritizes reports requiring urgent attention, and provides structured evidence-based explanations to support qualified human safety professionals.

---

## 2. Problem Being Solved

- **Information Overload**: HSE departments receive batches of hundreds of textual reports across drilling rigs, production manifolds, and gathering stations.
- **Hidden High-Severity Indicators**: Traditional frequency-based safety models treat minor slips and near-catastrophic high-energy releases with similar reporting weights. SIF precursors require distinct classification.
- **Triage Delay**: Manually reading through hundreds of reports creates delays in addressing critical barrier failures before an incident can recur.
- **Inconsistent Assessment**: Different inspectors may grade identical hazards with varying severity without standardized criteria.

---

## 3. Architecture

The platform uses a hybrid architectural pipeline:

```
[ Field Safety Reports (PDF, DOCX, TXT, ZIP) ]
                     │
                     ▼
      [ Upload & Text Extraction Layer ]
                     │
                     ▼
      [ Async Background Job Queue ]
                     │
                     ▼
      [ LLM Extraction & Factor Parsing ]
        (Strict JSON schema extraction)
                     │
                     ▼
      [ Deterministic Hybrid Risk Engine ]
        (Domain-configured hazard weighting)
                     │
                     ▼
     [ SQLite Enterprise Storage & Indexes ]
                     │
                     ▼
    [ Fast REST API & Live Polling Worker ]
                     │
                     ▼
  [ Single-Page Vanilla HTML5/CSS3/JS UI ]
                     │
                     ▼
       [ Qualified Human Safety Review ]
```

---

## 4. Technology Stack

### Frontend
- **HTML5**: Clean, accessible, semantic structure.
- **CSS3**: Pure custom enterprise stylesheet with restrained status colors, crisp typography, and responsive grid layouts. No Tailwind, no Bootstrap.
- **Vanilla JavaScript (ES6+)**: Zero framework bloat (No React, Vue, Angular, or jQuery). Native `fetch` APIs, drag-and-drop file handling, real-time polling, and modal interactions.

### Backend
- **Python (FastAPI)**: Asynchronous REST endpoints, non-blocking background workers, and Pydantic validation.
- **Node.js (Express / tsx)**: Live container runtime bridge providing native multi-format file extraction and port 3000 hosting.
- **Database**: SQLite with indexed tables for lightning-fast queries, designed with standard SQL for migration to PostgreSQL.
- **AI / NLP**: Google Gemini API via `@google/genai` (model: `gemini-3.8-flash`) with structured JSON schema output and deterministic offline fallback.

---

## 5. Folder Structure

```
sif-safety-ai/
├── backend/
│   ├── main.py            # FastAPI REST endpoints & background task worker
│   ├── analyzer.py        # LLM extractor & hybrid risk scoring engine
│   └── database.py        # SQLite schema, tables, and indexed queries
├── frontend/
│   ├── index.html         # Single-page enterprise dashboard interface
│   ├── style.css          # Professional light-theme CSS3 design system
│   └── script.js          # Client-side state, upload handler, and table logic
├── uploads/
│   └── samples/           # Realistic OIL operational test reports
├── server.ts              # Full-stack server running container on port 3000
├── requirements.txt       # Python dependencies
├── package.json           # Node server and build configuration
├── .env.example           # Environment configuration template
└── README.md              # Technical and operational guide
```

---

## 6. Installation & Prerequisites

### Python Backend
```bash
# 1. Create a virtual environment
python3 -m venv venv
source venv/bin/activate

# 2. Install Python requirements
pip install -r requirements.txt
```

### Full-Stack Node Container
```bash
npm install
```

---

## 7. Environment Variables

Configure your `.env` file according to `.env.example`:

```env
# Gemini API Key (injected by AI Studio or obtained from Google AI Studio)
GEMINI_API_KEY="your_api_key_here"

# Model Selection
LLM_PROVIDER="gemini"
LLM_MODEL="gemini-3.8-flash"

# Port & Database Path
PORT=3000
SQLITE_DB_PATH="sif_safety.sqlite"
UPLOAD_DIR="uploads"
```

---

## 8. How to Run Backend

To run the Python FastAPI backend directly:
```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```
Interactive OpenAPI documentation will be available at `http://localhost:8000/docs`.

---

## 9. How to Run Frontend

In the container development environment:
```bash
npm run dev
```
The server will start on port `3000` and serve the vanilla frontend and backend API.

---

## 10. How Bulk Analysis Works

1. **Batch Upload**: Safety officers select multiple PDF, DOCX, or TXT files, or drag-and-drop a `.zip` archive containing hundreds of reports.
2. **Immediate Job Creation**: The backend parses incoming files, stores raw text, generates a unique UUID `job_id`, and immediately returns HTTP 202 without blocking the browser.
3. **Asynchronous Processing**: Background workers sequentially process reports with controlled concurrency to respect API rate limits.
4. **Live Polling**: The frontend polls `GET /api/jobs/{job_id}` every 800ms, displaying the current report filename, active processing stage, and percentage bar.
5. **Dynamic Dashboard Refresh**: Upon job completion, summary metrics, priority tables, and trend analytics reload automatically.

---

## 11. How the LLM Is Used

The LLM is deployed via an abstraction layer strictly for **information extraction and language comprehension**, not for arbitrary risk scoring. 
- **Strict JSON Output**: The LLM adheres to a validated schema (`report_type`, `activity`, `equipment`, `location`, `hazards`, `unsafe_acts`, `unsafe_conditions`, `ppe_issues`, `worker_exposure`, `missing_controls`, `sif_indicators`, `evidence`, `summary`).
- **Zero Hallucination Principle**: The prompt strictly instructs the model to extract evidence solely present in the report narrative.
- **Fail-Safe Fallback**: If an API quota is reached or network connectivity drops, the system seamlessly activates a deterministic safety-domain keyword and pattern analyzer.

---

## 12. How SIF Detection Works

A **Potential SIF Precursor** is identified when high-severity hazard conditions coincide with direct worker exposure or broken barrier controls:
- **High-Energy Hazards**: Flammable gas release, hot work in hazardous areas, toxic H2S release, high-pressure kick/release, fall from elevation (>2m), suspended heavy loads, confined space entry.
- **Barrier Failures**: Omission of Lockout-Tagout (LOTO), missing blind flanges, uninspected scaffolding, deactivated detectors.
- **Worker Line-of-Fire**: Physical worker presence in the hazardous zone without verified secondary arrest or protection.

---

## 13. How Risk Prioritization Works

The hybrid Risk Engine calculates:

$$\text{Risk Score} = (\text{Base} + \sum \text{Hazard Weights}) \times \text{Exposure Multipliers}$$

- **Critical ($75-100$)**: Priority Rank 1. Immediate high-energy hazard with worker exposure or multiple compounding threats.
- **High ($50-74$)**: Priority Rank 2. Major hazard present with compromised control or unconfirmed barrier status.
- **Medium ($25-49$)**: Priority Rank 3. Moderate hazard with existing barriers partially intact or minor procedural deviations.
- **Low ($0-24$)**: Priority Rank 4. Routine housekeeping, expired tags without immediate release, or minor ergonomic issues.

---

## 14. Database Schema

The SQLite schema utilizes four primary relational tables:
- `reports`: Stores raw uploaded file content, filename, detected type, and processing status.
- `analysis`: Stores SIF flags, numeric risk scores, risk levels, explanations, and suggested actions.
- `factors`: Normalized list of individual safety factors, types (hazard, unsafe act, etc.), and verbatim textual evidence.
- `reviews`: Human review audit trail with status (`Pending Review`, `Confirmed`, `Not a SIF Precursor`, `Requires Further Review`), reviewer identity, and timestamp.
- `jobs`: Tracks asynchronous batch progress.

Indexes are created on `report_type`, `risk_level`, `sif_detected`, `processing_status`, and `uploaded_at` for high-throughput filtering.

---

## 15. Limitations

- **Scanned Image PDFs**: Current extraction operates on digital text streams. Scanned raster PDFs require an upstream OCR step (e.g., Tesseract or Google Cloud Document AI).
- **Network Boundaries**: Cloud LLM API access requires outbound internet connectivity unless a local Ollama/vLLM backend is specified in `LLM_PROVIDER`.

---

## 16. Safety & Human Oversight

> **CRITICAL DECISION-SUPPORT MANDATE**:
> This platform is an automated decision-support system designed to assist human safety teams. The AI outputs:
> - Do NOT claim that an accident or fatality will definitely happen.
> - Do NOT constitute mandatory operational commands or work stoppage permits.
> - Use calibrated non-definitive language: *"Potential SIF precursor detected"*, *"Requires safety review"*, *"Prioritized for human review"*.
> 
> Final safety determinations and corrective actions remain the exclusive responsibility of qualified Oil India Limited safety personnel.

---

## 17. Replacing Prototype Risk Criteria with Validated OIL Domain Criteria

The scoring parameters located in `backend/analyzer.py` under `DEFAULT_RISK_CONFIG` are documented prototype values. To integrate official Oil India Limited Risk Assessment Matrix (RAM) guidelines:

1. Open `backend/analyzer.py`.
2. Update the `sif_trigger_factors` dictionary with OIL-specific hazard codes and company RAM probability/consequence ratings.
3. Calibrate `severity_multipliers` against historical OIL HSE incident databases.
4. Adjust `thresholds` for Critical/High/Medium/Low according to corporate safety governance standards.
