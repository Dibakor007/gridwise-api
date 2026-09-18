# Smart Campus Energy Optimization Challenge - Reference Submission
**BUP CSE FEST 2026 Preliminary Round**

A production-grade, mathematically optimal microgrid energy dispatch service implementing:
1. **LLM in the Critical Path**: Structured operator directive extraction using the `google-genai` SDK (`gemini-3.8-flash` with `gemini-flash-latest` fallback).
2. **Deterministic Guardrails**: Validates and clamps all LLM outputs before mathematical scheduling (prevents hallucinated demand shifts, negative factors, or out-of-range hours).
3. **Exact Mathematical Optimization**: Formulated as a Linear Program (LP) using **PuLP / CBC** to minimize total energy procurement cost across 24 hours while strictly enforcing hourly energy balance, battery capacity/power bounds, and end-of-day battery neutrality ($E_{23} = E_{\text{initial}}$).
4. **Strict API Contract**: Exposes exclusively `GET /health` and `POST /optimize-energy`.

---

## 1. Project Structure

```
.
├── main.py                  # FastAPI application with Pydantic v2, Google GenAI, & PuLP solver
├── requirements.txt         # Python runtime dependencies
├── Dockerfile               # Production multi-stage Docker build (no baked secrets)
├── docker-compose.yml       # Container orchestration
├── README.md                # Comprehensive documentation, math formulations, & verification
└── .env.example             # Example environment variables template
```

---

## 2. API Contract Specification

### A. Health Check
* **Method**: `GET`
* **Path**: `/health`
* **Response**:
```json
{
  "status": "ok"
}
```

### B. Energy Optimization
* **Method**: `POST`
* **Path**: `/optimize-energy`
* **Headers**: `Content-Type: application/json`
* **Request Schema**:
```json
{
  "scenario_id": "SAMPLE-01",
  "operator_notes": [
    "Facilities will wash the rooftop solar panels from noon until 2 PM. During cleaning, usable solar should be treated as roughly 25% of the forecast.",
    "The sports office moved next month's registration deadline."
  ],
  "hours": [
    { "hour": 0, "demand_kwh": 90, "solar_kwh": 0, "tariff_bdt_per_kwh": 6 },
    ...
    { "hour": 23, "demand_kwh": 105, "solar_kwh": 0, "tariff_bdt_per_kwh": 7 }
  ],
  "battery": {
    "capacity_kwh": 220,
    "initial_energy_kwh": 110,
    "minimum_energy_kwh": 40,
    "max_charge_kwh_per_hour": 50,
    "max_discharge_kwh_per_hour": 50
  }
}
```
* **Response Schema**:
```json
{
  "scenario_id": "SAMPLE-01",
  "directive_interpretation": [
    {
      "note_index": 0,
      "applies": true,
      "directive_type": "solar_reduction",
      "structured_adjustment": {
        "hours": [12, 13],
        "factor": 0.25
      },
      "explanation": "Solar availability reduced to 25% from 12:00 to 14:00."
    },
    {
      "note_index": 1,
      "applies": false,
      "directive_type": "no_op",
      "structured_adjustment": null,
      "explanation": "Administrative note irrelevant to energy dispatch."
    }
  ],
  "hourly_plan": [
    {
      "hour": 0,
      "grid_import_kwh": 90.0,
      "solar_used_kwh": 0.0,
      "battery_charge_kwh": 0.0,
      "battery_discharge_kwh": 0.0,
      "battery_action": "idle",
      "battery_energy_after_kwh": 110.0,
      "hourly_cost_bdt": 540.0
    },
    ...
  ],
  "total_grid_kwh": 2185.0,
  "total_cost_bdt": 29840.0,
  "peak_grid_kwh": 185.0
}
```

---

## 3. Mathematical Optimization Formulation

The microgrid dispatch problem is formulated as a Linear Program (LP) over the 24-hour horizon $h \in \{0, \dots, 23\}$:

$$\min \sum_{h=0}^{23} \text{grid}_h \times \text{tariff}_h$$

Subject to:

1. **Hourly Energy Balance**:
   $$\text{grid}_h + \text{solar\_used}_h + \text{discharge}_h = \text{demand}_h + \text{charge}_h \quad \forall h$$

2. **Solar Generation Availability**:
   $$0 \le \text{solar\_used}_h \le \text{effective\_solar}_h \quad \forall h$$
   where $\text{effective\_solar}_h = \text{solar}_h \times \text{solar\_factor}_h$.

3. **Battery Power Bounds**:
   $$0 \le \text{charge}_h \le P_{\text{charge, max}} \times \mathbf{1}_{\text{charge\_allowed}, h}$$
   $$0 \le \text{discharge}_h \le P_{\text{discharge, max}} \times \mathbf{1}_{\text{discharge\_allowed}, h}$$

4. **Battery Energy State Transition**:
   $$E_0 = E_{\text{initial}} + \text{charge}_0 - \text{discharge}_0$$
   $$E_h = E_{h-1} + \text{charge}_h - \text{discharge}_h \quad \forall h \in \{1, \dots, 23\}$$

5. **Operational Capacity & Dynamic Reserves**:
   $$\text{min\_reserve}_h \le E_h \le C_{\text{battery}} \quad \forall h$$

6. **End-of-Day Neutrality**:
   $$E_{23} = E_{\text{initial}}$$

---

## 4. Deterministic Guardrails

Before feeding LLM interpretations into the solver, our pipeline executes deterministic validation:
* **Hour Range Integrity**: All time windows must be start-inclusive, end-exclusive integer subsets of $\{0, \dots, 23\}$.
* **Solar Fraction Clamping**: `factor` is constrained strictly to $[0.0, 1.0]$ (representing usable remaining solar).
* **Reserve Bounds Check**: `minimum_energy_kwh` cannot exceed `battery.capacity_kwh` or drop below 0.
* **No-Op Normalization**: Notes marked `no_op` are explicitly set to `applies = false` and `structured_adjustment = null`.
* **Demand Immutability**: Base electrical demands are strictly protected from modification by operator notes.

---

## 5. Docker Deployment & Local Execution

### Local Python Setup
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY="your-api-key-here"
uvicorn main:app --host 0.0.0.0 --port 8000
```

### Docker Build & Run (No Baked Secrets)
```bash
# Build production image
docker build -t bup-gridwise-optimizer:latest .

# Run container passing API key at runtime
docker run -d -p 8000:8000 -e GEMINI_API_KEY="your-api-key-here" --name energy-api bup-gridwise-optimizer:latest
```

---

## 6. Verification with cURL

```bash
# Health probe
curl -s http://localhost:8000/health

# Scenario optimization
curl -s -X POST http://localhost:8000/optimize-energy \
  -H "Content-Type: application/json" \
  -d @sample_request.json
```
