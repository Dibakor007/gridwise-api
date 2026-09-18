import os
import json
import re
import logging
from typing import List, Optional, Literal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import pulp
from google import genai
from google.genai import types
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gridwise")

app = FastAPI(title="GridWise API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Schemas
class HourData(BaseModel):
    hour: int
    demand_kwh: float
    solar_kwh: float
    tariff_bdt_per_kwh: float

class BatteryData(BaseModel):
    capacity_kwh: float
    initial_energy_kwh: float
    minimum_energy_kwh: float
    max_charge_kwh_per_hour: float
    max_discharge_kwh_per_hour: float

class OptimizeRequest(BaseModel):
    scenario_id: str
    operator_notes: List[str]
    hours: List[HourData]
    battery: BatteryData

class StructuredAdjustment(BaseModel):
    hours: List[int]
    factor: Optional[float] = None
    minimum_energy_kwh: Optional[float] = None
    max_grid_kwh: Optional[float] = None

class DirectiveInterpretation(BaseModel):
    note_index: int
    applies: bool
    directive_type: Literal[
        "solar_reduction",
        "minimum_battery_reserve",
        "no_charge_window",
        "no_discharge_window",
        "max_grid_window",
        "no_op"
    ]
    structured_adjustment: Optional[StructuredAdjustment] = None
    explanation: str

class HourlyPlan(BaseModel):
    hour: int
    grid_kwh: float
    solar_used_kwh: float
    battery_action: Literal["charge", "discharge", "idle"]
    battery_kwh: float
    battery_energy_after_kwh: float

class OptimizeResponse(BaseModel):
    scenario_id: str
    directive_interpretation: List[DirectiveInterpretation]
    hourly_plan: List[HourlyPlan]
    total_grid_kwh: float
    total_cost_bdt: float
    peak_grid_kwh: float
    plan_summary: str

# 2. LLM + Fallback
SYSTEM_PROMPT = """You are an energy management assistant for a smart campus grid.
Interpret operator notes into structured directives for a 24-hour energy scheduler (hours 0-23).
Directives:
1. `solar_reduction`: {"hours": [int...], "factor": float} (factor = fraction REMAINING, e.g. 80% reduction -> factor 0.2)
2. `minimum_battery_reserve`: {"hours": [int...], "minimum_energy_kwh": float}
3. `no_charge_window`: {"hours": [int...]}
4. `no_discharge_window`: {"hours": [int...]}
5. `max_grid_window`: {"hours": [int...], "max_grid_kwh": float}
6. `no_op`: applies: false, structured_adjustment: null (irrelevant notes)
Time windows are start-inclusive, end-exclusive: "1 PM to 3 PM" -> [13, 14].
Output raw JSON array in note_index order."""

def parse_time_window(text: str) -> List[int]:
    t = text.lower()
    m24 = re.search(r'(\d{1,2}):00\s*(?:to|-|until)\s*(\d{1,2}):00', t)
    if m24:
        s, e = int(m24.group(1)), int(m24.group(2))
        if 0 <= s < e <= 24: return list(range(s, e))
    m12 = re.search(r'(\d{1,2})\s*(am|pm)\s*(?:to|-|and|until)\s*(\d{1,2})\s*(am|pm)', t)
    if m12:
        h1, p1, h2, p2 = int(m12.group(1)), m12.group(2), int(m12.group(3)), m12.group(4)
        if p1 == 'pm' and h1 < 12: h1 += 12
        if p1 == 'am' and h1 == 12: h1 = 0
        if p2 == 'pm' and h2 < 12: h2 += 12
        if p2 == 'am' and h2 == 12: h2 = 0
        if 0 <= h1 < h2 <= 24: return list(range(h1, h2))
    return []

def fallback_parser(notes: List[str]) -> List[DirectiveInterpretation]:
    res = []
    for idx, note in enumerate(notes):
        nl = note.lower()
        hrs = parse_time_window(note)
        if any(w in nl for w in ["solar", "pv", "washing", "sunlight"]):
            factor = 0.2 if ("80%" in nl or "20%" in nl) else 0.5 if "50%" in nl else 0.25
            res.append(DirectiveInterpretation(note_index=idx, applies=bool(hrs), directive_type="solar_reduction" if hrs else "no_op", structured_adjustment=StructuredAdjustment(hours=hrs, factor=factor) if hrs else None, explanation="Solar adjustment"))
        elif any(w in nl for w in ["reserve", "keep at least", "minimum energy"]):
            m = re.search(r'(\d+)\s*kwh', nl)
            val = float(m.group(1)) if m else 100.0
            res.append(DirectiveInterpretation(note_index=idx, applies=bool(hrs), directive_type="minimum_battery_reserve" if hrs else "no_op", structured_adjustment=StructuredAdjustment(hours=hrs, minimum_energy_kwh=val) if hrs else None, explanation="Reserve limit"))
        elif "charge" in nl and any(w in nl for w in ["do not", "no", "stop", "unavailable"]):
            res.append(DirectiveInterpretation(note_index=idx, applies=bool(hrs), directive_type="no_charge_window" if hrs else "no_op", structured_adjustment=StructuredAdjustment(hours=hrs) if hrs else None, explanation="No charge"))
        elif "discharge" in nl and any(w in nl for w in ["do not", "no", "stop", "unavailable"]):
            res.append(DirectiveInterpretation(note_index=idx, applies=bool(hrs), directive_type="no_discharge_window" if hrs else "no_op", structured_adjustment=StructuredAdjustment(hours=hrs) if hrs else None, explanation="No discharge"))
        elif any(w in nl for w in ["max grid", "cap", "feeder", "intake"]):
            m = re.search(r'(\d+)\s*kwh', nl)
            val = float(m.group(1)) if m else 155.0
            res.append(DirectiveInterpretation(note_index=idx, applies=bool(hrs), directive_type="max_grid_window" if hrs else "no_op", structured_adjustment=StructuredAdjustment(hours=hrs, max_grid_kwh=val) if hrs else None, explanation="Grid cap"))
        else:
            res.append(DirectiveInterpretation(note_index=idx, applies=False, directive_type="no_op", structured_adjustment=None, explanation="Irrelevant note"))
    return res

def interpret_notes(notes: List[str]) -> List[DirectiveInterpretation]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return fallback_parser(notes)
    try:
        client = genai.Client(api_key=api_key)
        prompt = f"Notes to interpret:\n" + "\n".join([f"Note {i}: {n}" for i, n in enumerate(notes)])
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[SYSTEM_PROMPT, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=list[DirectiveInterpretation],
                temperature=0.0
            )
        )
        return [DirectiveInterpretation(**item) for item in json.loads(response.text)]
    except Exception as e:
        logger.error(f"LLM Error: {e}")
        return fallback_parser(notes)

# 3. Guardrails
def guard_directives(directives: List[DirectiveInterpretation]) -> List[DirectiveInterpretation]:
    for i, d in enumerate(directives):
        d.note_index = i
        if d.directive_type == "no_op":
            d.applies = False
            d.structured_adjustment = None
        else:
            d.applies = True
            if d.structured_adjustment:
                d.structured_adjustment.hours = sorted(list(set([h for h in d.structured_adjustment.hours if 0 <= h <= 23])))
    return directives

# 4. Math Optimizer
def optimize_schedule(req: OptimizeRequest, directives: List[DirectiveInterpretation]) -> OptimizeResponse:
    prob = pulp.LpProblem("Cost_Minimization", pulp.LpMinimize)
    grid = pulp.LpVariable.dicts("grid", range(24), lowBound=0.0)
    solar_used = pulp.LpVariable.dicts("solar_used", range(24), lowBound=0.0)
    charge = pulp.LpVariable.dicts("charge", range(24), lowBound=0.0)
    discharge = pulp.LpVariable.dicts("discharge", range(24), lowBound=0.0)
    e_after = pulp.LpVariable.dicts("e_after", range(24), lowBound=0.0)

    effective_solar = [h.solar_kwh for h in req.hours]
    min_reserve = [req.battery.minimum_energy_kwh for _ in range(24)]
    max_grid = [None for _ in range(24)]
    no_charge = [False for _ in range(24)]
    no_discharge = [False for _ in range(24)]

    for d in directives:
        if not d.applies or not d.structured_adjustment: continue
        hrs = d.structured_adjustment.hours
        if d.directive_type == "solar_reduction" and d.structured_adjustment.factor is not None:
            for h in hrs: effective_solar[h] *= d.structured_adjustment.factor
        elif d.directive_type == "minimum_battery_reserve" and d.structured_adjustment.minimum_energy_kwh is not None:
            for h in hrs: min_reserve[h] = max(min_reserve[h], d.structured_adjustment.minimum_energy_kwh)
        elif d.directive_type == "max_grid_window":
            for h in hrs: max_grid[h] = d.structured_adjustment.max_grid_kwh
        elif d.directive_type == "no_charge_window":
            for h in hrs: no_charge[h] = True
        elif d.directive_type == "no_discharge_window":
            for h in hrs: no_discharge[h] = True

    prob += pulp.lpSum([grid[h] * req.hours[h].tariff_bdt_per_kwh for h in range(24)])

    for h in range(24):
        prob += solar_used[h] <= effective_solar[h]
        prob += charge[h] <= req.battery.max_charge_kwh_per_hour
        prob += discharge[h] <= req.battery.max_discharge_kwh_per_hour
        prob += grid[h] + solar_used[h] + discharge[h] == req.hours[h].demand_kwh + charge[h]
        
        if h == 0:
            prob += e_after[0] == req.battery.initial_energy_kwh + charge[0] - discharge[0]
        else:
            prob += e_after[h] == e_after[h - 1] + charge[h] - discharge[h]

        prob += e_after[h] >= min_reserve[h]
        prob += e_after[h] <= req.battery.capacity_kwh
        if no_charge[h]: prob += charge[h] == 0.0
        if no_discharge[h]: prob += discharge[h] == 0.0
        if max_grid[h] is not None: prob += grid[h] <= max_grid[h]

    prob += e_after[23] == req.battery.initial_energy_kwh
    prob.solve(pulp.PULP_CBC_CMD(msg=False))

    hourly_plan = []
    total_grid = total_cost = peak_grid = 0.0
    for h in range(24):
        g = round(float(pulp.value(grid[h])), 2)
        c = round(float(pulp.value(charge[h])), 2)
        d = round(float(pulp.value(discharge[h])), 2)
        action = "charge" if c > 0.01 else "discharge" if d > 0.01 else "idle"
        kwh = c if action == "charge" else d if action == "discharge" else 0.0

        hourly_plan.append(HourlyPlan(
            hour=h, grid_kwh=g, solar_used_kwh=round(float(pulp.value(solar_used[h])), 2),
            battery_action=action, battery_kwh=kwh, battery_energy_after_kwh=round(float(pulp.value(e_after[h])), 2)
        ))
        total_grid += g
        total_cost += g * req.hours[h].tariff_bdt_per_kwh
        peak_grid = max(peak_grid, g)

    return OptimizeResponse(
        scenario_id=req.scenario_id, directive_interpretation=directives, hourly_plan=hourly_plan,
        total_grid_kwh=round(total_grid, 2), total_cost_bdt=round(total_cost, 2), peak_grid_kwh=round(peak_grid, 2),
        plan_summary="Schedule mathematically optimized obeying all interpreted directives."
    )

# 5. Endpoints
@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/")
def root():
    return {"status": "ok", "service": "GridWise API"}

@app.post("/optimize-energy", response_model=OptimizeResponse)
def optimize_energy(payload: OptimizeRequest):
    try:
        raw = interpret_notes(payload.operator_notes)
        validated = guard_directives(raw)
        return optimize_schedule(payload, validated)
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail="Controlled internal error")
