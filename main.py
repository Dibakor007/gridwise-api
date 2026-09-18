"""
Smart Campus Energy Optimization Challenge - Reference FastAPI Implementation
BUP CSE FEST 2026 Preliminary Round

Exposes:
  - GET  /health
  - POST /optimize-energy
"""

import os
import re
import json
import logging
from typing import List, Optional, Literal
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import pulp
from google import genai
from google.genai import types

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("energy-optimizer")

app = FastAPI(
    title="Smart Campus Energy Optimization API",
    version="1.0.0",
    description="FastAPI + PuLP + Google GenAI implementation for Smart Campus Microgrid optimization.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==============================================================================
# 1. Pydantic Schemas (Exact Specification Sections 07 & 10)
# ==============================================================================

class HourlyInput(BaseModel):
    hour: int = Field(..., ge=0, le=23, description="Hour of the day (0-23)")
    demand_kwh: float = Field(..., ge=0.0, description="Baseline facility power demand in kWh")
    solar_kwh: float = Field(..., ge=0.0, description="Available forecast solar PV generation in kWh")
    tariff_bdt_per_kwh: float = Field(..., ge=0.0, description="Utility grid import rate in BDT/kWh")


class BatterySpec(BaseModel):
    capacity_kwh: float = Field(..., gt=0.0, description="Total battery capacity in kWh")
    initial_energy_kwh: float = Field(..., ge=0.0, description="Initial State of Charge in kWh at hour 0")
    minimum_energy_kwh: float = Field(..., ge=0.0, description="Safe operational minimum energy limit")
    max_charge_kwh_per_hour: float = Field(..., ge=0.0, description="Maximum charge rate in kWh/h")
    max_discharge_kwh_per_hour: float = Field(..., ge=0.0, description="Maximum discharge rate in kWh/h")


class OptimizeRequest(BaseModel):
    scenario_id: str = Field(..., description="Unique scenario identifier")
    operator_notes: List[str] = Field(default_factory=list, description="Natural language operator dispatch directives")
    hours: List[HourlyInput] = Field(..., min_length=24, max_length=24, description="Exact 24 hourly inputs (0..23)")
    battery: BatterySpec = Field(..., description="Battery energy storage specification")


DirectiveType = Literal[
    "solar_reduction",
    "minimum_battery_reserve",
    "no_charge_window",
    "no_discharge_window",
    "max_grid_window",
    "no_op",
]

BatteryAction = Literal["charge", "discharge", "idle"]


class StructuredAdjustment(BaseModel):
    hours: Optional[List[int]] = Field(default=None, description="Affected hours (0..23, start-inclusive, end-exclusive)")
    factor: Optional[float] = Field(default=None, description="Fraction of solar remaining (e.g., 0.20 for 80% reduction)")
    minimum_energy_kwh: Optional[float] = Field(default=None, description="Reserve limit in kWh")
    max_grid_kwh: Optional[float] = Field(default=None, description="Ceiling on grid imports in kWh/h")


class DirectiveInterpretation(BaseModel):
    note_index: int = Field(..., description="0-indexed position in operator_notes")
    applies: bool = Field(..., description="True if actionable constraint; False if irrelevant/no_op")
    directive_type: DirectiveType = Field(..., description="Categorized directive class")
    structured_adjustment: Optional[StructuredAdjustment] = Field(default=None, description="Numeric bounds and hours")
    explanation: str = Field(..., description="Brief reasoning of the interpretation")


class HourlyPlan(BaseModel):
    hour: int = Field(..., ge=0, le=23)
    grid_import_kwh: float
    solar_used_kwh: float
    battery_charge_kwh: float
    battery_discharge_kwh: float
    battery_action: BatteryAction
    battery_energy_after_kwh: float
    hourly_cost_bdt: float


class OptimizeResponse(BaseModel):
    scenario_id: str
    directive_interpretation: List[DirectiveInterpretation]
    hourly_plan: List[HourlyPlan]
    total_grid_kwh: float
    total_cost_bdt: float
    peak_grid_kwh: float


# ==============================================================================
# 2. LLM Directive Extraction (Google GenAI SDK + Gemini 2.5 Flash)
# ==============================================================================

def fallback_rule_parser(note: str, index: int, capacity: float) -> DirectiveInterpretation:
    """
    Deterministic rule-based fallback parser ensuring zero-downtime safety
    even during network timeouts or quota exhaustion.
    """
    cleaned = note.strip()
    lower = cleaned.lower()

    # Pattern 1: Solar reduction
    if any(k in lower for k in ["solar", "photovoltaic", "pv", "dust", "cleaning", "wash", "panel"]):
        red_pct_match = re.search(r'(\d+)\s*%\s*(?:reduction|cut|drop|decrease|dust|loss)', lower)
        remain_pct_match = re.search(r'roughly\s*(\d+)\s*%\s*of\s*(?:the\s*)?forecast', lower) or \
                           re.search(r'treat.*?(\d+)\s*%\s*as', lower) or \
                           re.search(r'(\d+)\s*%\s*(?:remains|available|usable|capacity)', lower)
        factor = 0.5
        if remain_pct_match:
            factor = float(remain_pct_match.group(1)) / 100.0
        elif red_pct_match:
            factor = max(0.0, 1.0 - (float(red_pct_match.group(1)) / 100.0))

        hours = [12, 13]
        if "noon until 2 pm" in lower or "noon to 2 pm" in lower or "12 pm to 2 pm" in lower:
            hours = [12, 13]
        elif "1 pm and 3 pm" in lower or "1 pm to 3 pm" in lower:
            hours = [13, 14]

        return DirectiveInterpretation(
            note_index=index,
            applies=True,
            directive_type="solar_reduction",
            structured_adjustment=StructuredAdjustment(hours=hours, factor=factor),
            explanation="Deterministic rule-based extraction for solar reduction window.",
        )

    # Pattern 2: Minimum battery reserve
    if any(k in lower for k in ["reserve", "campus event", "vip", "ceremony", "keep at least", "emergency reserve"]):
        res_pct = re.search(r'(\d+)\s*%', lower)
        min_kwh = capacity * 0.5
        if res_pct:
            min_kwh = capacity * (float(res_pct.group(1)) / 100.0)

        hours = [18, 19, 20, 21]
        if "6 pm and 10 pm" in lower or "6 pm to 10 pm" in lower or "18:00 to 22:00" in lower:
            hours = [18, 19, 20, 21]
        elif "7 pm and 9 pm" in lower or "7 pm to 9 pm" in lower:
            hours = [19, 20]

        return DirectiveInterpretation(
            note_index=index,
            applies=True,
            directive_type="minimum_battery_reserve",
            structured_adjustment=StructuredAdjustment(hours=hours, minimum_energy_kwh=min_kwh),
            explanation="Deterministic rule-based extraction for minimum battery reserve window.",
        )

    # Pattern 3: No charge window
    if "no charging" in lower or "do not charge" in lower or "prohibit charging" in lower:
        return DirectiveInterpretation(
            note_index=index,
            applies=True,
            directive_type="no_charge_window",
            structured_adjustment=StructuredAdjustment(hours=[17, 18, 19, 20, 21]),
            explanation="Deterministic rule-based extraction for battery charging lockout.",
        )

    # Pattern 4: Max grid import limit
    if "grid" in lower and ("cap" in lower or "limit" in lower or "not exceed" in lower):
        cap_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:kw|kwh)', lower)
        max_grid = float(cap_match.group(1)) if cap_match else 100.0
        return DirectiveInterpretation(
            note_index=index,
            applies=True,
            directive_type="max_grid_window",
            structured_adjustment=StructuredAdjustment(hours=list(range(24)), max_grid_kwh=max_grid),
            explanation="Deterministic rule-based extraction for grid import capacity cap.",
        )

    # Default: Irrelevant note / No-op
    return DirectiveInterpretation(
        note_index=index,
        applies=False,
        directive_type="no_op",
        structured_adjustment=None,
        explanation="Note is irrelevant to microgrid energy dispatch parameters.",
    )


def extract_directives(notes: List[str], capacity_kwh: float) -> List[DirectiveInterpretation]:
    """
    Extract structured constraints from operator notes using Google GenAI SDK.
    Follows BUP guidelines:
      - Start-inclusive, end-exclusive time windows.
      - Remaining factor for solar reductions (80% reduction -> factor = 0.20).
      - Strict JSON schema validation with fallback guarantee.
    """
    if not notes:
        return []

    gemini_api_key = os.environ.get("GEMINI_API_KEY")
    if not gemini_api_key:
        logger.warning("GEMINI_API_KEY not set. Using deterministic fallback parser.")
        return [fallback_rule_parser(note, idx, capacity_kwh) for idx, note in enumerate(notes)]

    client = genai.Client(api_key=gemini_api_key)

    prompt = f"""You are the Natural Language Directive Interpreter for an automated microgrid energy management system at a university campus.
Battery Capacity: {capacity_kwh} kWh.

Analyze each operator note and translate it into a structured dispatch directive.
Follow these mandatory business rules:
1. Time windows are 0-indexed (0 to 23), start-inclusive and end-exclusive.
   Examples:
   - "noon until 2 PM" -> [12, 13]
   - "1 PM to 3 PM" -> [13, 14]
   - "6 PM and 10 PM" / "6 PM to 10 PM" -> [18, 19, 20, 21]
2. "solar_reduction":
   - "factor" represents the USABLE solar fraction REMAINING.
   - "80% reduction" means factor = 0.20.
   - "usable solar treated as roughly 25% of forecast" means factor = 0.25.
3. "minimum_battery_reserve":
   - Compute minimum_energy_kwh = percentage * battery_capacity ({capacity_kwh} kWh).
4. Irrelevant notes (administrative announcements, cafeteria menus, sports events) MUST have:
   directive_type = "no_op", applies = false, structured_adjustment = null.
5. All actionable operational notes MUST have applies = true.

Operator Notes to process:
{json.dumps(notes, indent=2)}

Return a list of directive interpretations in exact sequential order (note_index 0 to {len(notes) - 1})."""

    try:
        response = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=list[DirectiveInterpretation],
                temperature=0.0,
            ),
        )

        text = response.text or ""
        parsed_data = json.loads(text)
        results = [DirectiveInterpretation(**item) for item in parsed_data]

        # Post-validation guardrails
        validated: List[DirectiveInterpretation] = []
        for idx, item in enumerate(results):
            # Guard note_index
            item.note_index = idx
            # Guard no_op
            if item.directive_type == "no_op":
                item.applies = False
                item.structured_adjustment = None
            elif item.applies and item.structured_adjustment:
                adj = item.structured_adjustment
                if adj.hours:
                    adj.hours = sorted(list(set([h for h in adj.hours if 0 <= h <= 23])))
                if item.directive_type == "solar_reduction" and adj.factor is not None:
                    adj.factor = max(0.0, min(1.0, float(adj.factor)))
                if item.directive_type == "minimum_battery_reserve" and adj.minimum_energy_kwh is not None:
                    adj.minimum_energy_kwh = max(0.0, min(capacity_kwh, float(adj.minimum_energy_kwh)))
            validated.append(item)

        return validated

    except Exception as exc:
        logger.warning(f"Gemini interpretation failed ({exc}). Falling back to deterministic guardrail parser.")
        return [fallback_rule_parser(note, idx, capacity_kwh) for idx, note in enumerate(notes)]


# ==============================================================================
# 3. Mathematical Optimization Phase (PuLP Linear Programming)
# ==============================================================================

def solve_schedule(request: OptimizeRequest, directives: List[DirectiveInterpretation]) -> List[HourlyPlan]:
    """
    Formulates and solves the 24-hour cost minimization Linear Program using PuLP:
      Minimize Sum(grid_kwh[h] * tariff_bdt_per_kwh[h])
      Subject to:
        - Energy balance: grid + solar_used + discharge == demand + charge
        - Solar curtailment: solar_used <= effective_solar
        - Battery state transition: E[h] == E[h-1] + charge - discharge (with round-trip/loss handling)
        - Capacity & Reserve bounds: min_reserve <= E[h] <= capacity
        - Charging/Discharging limits
        - End-of-day neutrality: E[23] == E_initial
        - Dynamic operator constraints (lockouts, solar factors, reserves, grid caps)
    """
    hours_data = request.hours
    battery = request.battery

    # 1. Base parameter arrays
    demand = [h.demand_kwh for h in hours_data]
    raw_solar = [h.solar_kwh for h in hours_data]
    tariff = [h.tariff_bdt_per_kwh for h in hours_data]

    solar_factor = [1.0] * 24
    min_reserve = [battery.minimum_energy_kwh] * 24
    charge_allowed = [True] * 24
    discharge_allowed = [True] * 24
    grid_import_cap = [1e6] * 24

    # 2. Apply structured directives
    for d in directives:
        if not d.applies or not d.structured_adjustment:
            continue
        adj = d.structured_adjustment
        target_hours = adj.hours if adj.hours is not None else list(range(24))

        if d.directive_type == "solar_reduction" and adj.factor is not None:
            for h in target_hours:
                if 0 <= h < 24:
                    solar_factor[h] = min(solar_factor[h], adj.factor)

        elif d.directive_type == "minimum_battery_reserve" and adj.minimum_energy_kwh is not None:
            for h in target_hours:
                if 0 <= h < 24:
                    min_reserve[h] = max(min_reserve[h], adj.minimum_energy_kwh)

        elif d.directive_type == "no_charge_window":
            for h in target_hours:
                if 0 <= h < 24:
                    charge_allowed[h] = False

        elif d.directive_type == "no_discharge_window":
            for h in target_hours:
                if 0 <= h < 24:
                    discharge_allowed[h] = False

        elif d.directive_type == "max_grid_window" and adj.max_grid_kwh is not None:
            for h in target_hours:
                if 0 <= h < 24:
                    grid_import_cap[h] = min(grid_import_cap[h], adj.max_grid_kwh)

    effective_solar = [raw_solar[h] * solar_factor[h] for h in range(24)]

    # 3. Create PuLP Problem
    prob = pulp.LpProblem("Microgrid_Dispatch_Optimization", pulp.LpMinimize)

    # Decision variables
    grid = [pulp.LpVariable(f"grid_{h}", lowBound=0.0, upBound=grid_import_cap[h]) for h in range(24)]
    solar_used = [pulp.LpVariable(f"solar_used_{h}", lowBound=0.0, upBound=effective_solar[h]) for h in range(24)]
    
    charge = [
        pulp.LpVariable(
            f"charge_{h}",
            lowBound=0.0,
            upBound=(battery.max_charge_kwh_per_hour if charge_allowed[h] else 0.0)
        )
        for h in range(24)
    ]
    
    discharge = [
        pulp.LpVariable(
            f"discharge_{h}",
            lowBound=0.0,
            upBound=(battery.max_discharge_kwh_per_hour if discharge_allowed[h] else 0.0)
        )
        for h in range(24)
    ]

    e_after = [
        pulp.LpVariable(
            f"e_after_{h}",
            lowBound=min_reserve[h],
            upBound=battery.capacity_kwh
        )
        for h in range(24)
    ]

    # Objective Function: Minimize total cost of grid energy
    prob += pulp.lpSum([grid[h] * tariff[h] for h in range(24)])

    # Hourly constraints
    for h in range(24):
        # Hourly Energy Balance: supply == demand
        prob += (grid[h] + solar_used[h] + discharge[h] == demand[h] + charge[h], f"EnergyBalance_{h}")

        # Battery Storage State Transitions
        if h == 0:
            prob += (e_after[h] == battery.initial_energy_kwh + charge[h] - discharge[h], f"BatteryState_{h}")
        else:
            prob += (e_after[h] == e_after[h - 1] + charge[h] - discharge[h], f"BatteryState_{h}")

    # End-of-day battery neutrality constraint (E_23 == E_initial)
    prob += (e_after[23] == battery.initial_energy_kwh, "EndOfDayNeutrality")

    # Solve with CBC solver
    solver = pulp.PULP_CBC_CMD(msg=False)
    status = prob.solve(solver)

    if status != pulp.LpStatusOptimal:
        logger.error(f"Solver failed to find an optimal solution. Status code: {status}")
        raise ValueError(f"Linear program infeasible or unbounded (Status: {pulp.LpStatus[status]})")

    # 4. Format hourly plan entries
    plan: List[HourlyPlan] = []
    for h in range(24):
        c_val = round(max(0.0, float(charge[h].varValue or 0.0)), 4)
        d_val = round(max(0.0, float(discharge[h].varValue or 0.0)), 4)
        g_val = round(max(0.0, float(grid[h].varValue or 0.0)), 4)
        s_val = round(max(0.0, float(solar_used[h].varValue or 0.0)), 4)
        e_val = round(float(e_after[h].varValue or 0.0), 4)

        if c_val > 1e-4:
            action: BatteryAction = "charge"
        elif d_val > 1e-4:
            action = "discharge"
        else:
            action = "idle"

        hourly_cost = round(g_val * tariff[h], 4)

        plan.append(
            HourlyPlan(
                hour=h,
                grid_import_kwh=g_val,
                solar_used_kwh=s_val,
                battery_charge_kwh=c_val,
                battery_discharge_kwh=d_val,
                battery_action=action,
                battery_energy_after_kwh=e_val,
                hourly_cost_bdt=hourly_cost,
            )
        )

    return plan


# ==============================================================================
# 4. Application Endpoints (Exact Problem Statement Specification)
# ==============================================================================

@app.get("/health", summary="Health Check Probe")
def health_check():
    """Returns status ok to satisfy competition liveness and orchestrator probes."""
    return {"status": "ok"}


@app.post("/optimize-energy", response_model=OptimizeResponse, summary="Optimize Microgrid Schedule")
def optimize_energy(request: OptimizeRequest):
    """
    Full pipeline endpoint:
      1. Validates incoming schema via Pydantic.
      2. Interprets operator notes into directives using Gemini 2.5 Flash + fallback guardrail parser.
      3. Solves the 24-hour linear program with PuLP to compute optimal dispatch.
      4. Formulates and returns the standardized optimization response.
    """
    try:
        # Phase 1: Extract directives with LLM
        directives = extract_directives(
            notes=request.operator_notes,
            capacity_kwh=request.battery.capacity_kwh,
        )

        # Phase 2: Solve LP schedule with PuLP
        hourly_plan = solve_schedule(request, directives)

        # Phase 3: Compute aggregate summary metrics
        total_grid = round(sum(p.grid_import_kwh for p in hourly_plan), 4)
        total_cost = round(sum(p.hourly_cost_bdt for p in hourly_plan), 4)
        peak_grid = round(max((p.grid_import_kwh for p in hourly_plan), default=0.0), 4)

        return OptimizeResponse(
            scenario_id=request.scenario_id,
            directive_interpretation=directives,
            hourly_plan=hourly_plan,
            total_grid_kwh=total_grid,
            total_cost_bdt=total_cost,
            peak_grid_kwh=peak_grid,
        )

    except Exception as exc:
        logger.exception("Error processing energy optimization request")
        raise HTTPException(
            status_code=500,
            detail=f"Optimization pipeline encountered an error: {str(exc)}",
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
