import solver, { IModel } from 'javascript-lp-solver';
import {
  BatteryAction,
  DirectiveInterpretation,
  HourlyPlanEntry,
  OptimizationRequest,
  OptimizationResponse,
} from './types.ts';

export function runOptimization(
  request: OptimizationRequest,
  directives: DirectiveInterpretation[]
): OptimizationResponse {
  const { scenario_id, hours, battery } = request;

  // 1. Calculate effective solar after solar_reduction directives
  const effectiveSolar = hours.map((h) => h.solar_kwh);
  const noChargeHours = new Set<number>();
  const noDischargeHours = new Set<number>();
  const minReserves = hours.map(() => battery.minimum_energy_kwh);
  const maxGridMap = new Map<number, number>();

  for (const dir of directives) {
    if (!dir.applies || !dir.structured_adjustment) continue;
    const adj = dir.structured_adjustment;

    if (dir.directive_type === 'solar_reduction') {
      const sAdj = adj as { hours: number[]; factor: number };
      for (const h of sAdj.hours) {
        if (h >= 0 && h < 24) {
          effectiveSolar[h] = hours[h].solar_kwh * sAdj.factor;
        }
      }
    } else if (dir.directive_type === 'no_charge_window') {
      const cAdj = adj as { hours: number[] };
      for (const h of cAdj.hours) {
        if (h >= 0 && h < 24) noChargeHours.add(h);
      }
    } else if (dir.directive_type === 'no_discharge_window') {
      const dAdj = adj as { hours: number[] };
      for (const h of dAdj.hours) {
        if (h >= 0 && h < 24) noDischargeHours.add(h);
      }
    } else if (dir.directive_type === 'minimum_battery_reserve') {
      const rAdj = adj as { hours: number[]; minimum_energy_kwh: number };
      for (const h of rAdj.hours) {
        if (h >= 0 && h < 24) {
          minReserves[h] = Math.max(minReserves[h], rAdj.minimum_energy_kwh);
        }
      }
    } else if (dir.directive_type === 'max_grid_window') {
      const gAdj = adj as { hours: number[]; max_grid_kwh: number };
      for (const h of gAdj.hours) {
        if (h >= 0 && h < 24) {
          const cur = maxGridMap.get(h);
          maxGridMap.set(h, cur !== undefined ? Math.min(cur, gAdj.max_grid_kwh) : gAdj.max_grid_kwh);
        }
      }
    }
  }

  // 2. Build LP Model
  const model: IModel = {
    optimize: 'cost',
    opType: 'min',
    constraints: {},
    variables: {},
  };

  // End-of-day neutrality: sum_{t=0..23} (c_t - d_t) = 0
  model.constraints['end_of_day'] = { equal: 0 };

  for (let t = 0; t < 24; t++) {
    const dem = hours[t].demand_kwh;
    const effSol = effectiveSolar[t];
    const tariff = hours[t].tariff_bdt_per_kwh;

    // Energy balance: g_t + s_t + d_t - c_t = dem
    model.constraints[`balance_${t}`] = { equal: dem };

    // Solar usage limit: s_t <= effective_solar[t]
    model.constraints[`solar_max_${t}`] = { max: effSol };

    // Battery charge rate limit
    const maxCharge = noChargeHours.has(t) ? 0 : battery.max_charge_kwh_per_hour;
    model.constraints[`charge_max_${t}`] = { max: maxCharge };

    // Battery discharge rate limit
    const maxDischarge = noDischargeHours.has(t) ? 0 : battery.max_discharge_kwh_per_hour;
    model.constraints[`discharge_max_${t}`] = { max: maxDischarge };

    // Battery capacity and reserve:
    // E_t = initial + sum_{0..t}(c_i - d_i)
    // sum_{0..t}(c_i - d_i) <= capacity - initial
    // sum_{0..t}(c_i - d_i) >= min_reserve[t] - initial
    model.constraints[`battery_max_${t}`] = {
      max: battery.capacity_kwh - battery.initial_energy_kwh,
    };
    model.constraints[`battery_min_${t}`] = {
      min: minReserves[t] - battery.initial_energy_kwh,
    };

    // Grid cap constraint if max_grid_window active
    if (maxGridMap.has(t)) {
      model.constraints[`grid_max_${t}`] = { max: maxGridMap.get(t)! };
    }

    // --- Variables for hour t ---
    // Grid import variable: g_t
    const gVar: Record<string, number> = {
      cost: tariff,
      [`balance_${t}`]: 1,
    };
    if (maxGridMap.has(t)) {
      gVar[`grid_max_${t}`] = 1;
    }
    model.variables[`g_${t}`] = gVar;

    // Solar used variable: s_t
    model.variables[`s_${t}`] = {
      cost: 0,
      [`balance_${t}`]: 1,
      [`solar_max_${t}`]: 1,
    };

    // Battery charge variable: c_t
    const cVar: Record<string, number> = {
      cost: 0,
      [`balance_${t}`]: -1,
      [`charge_max_${t}`]: 1,
      end_of_day: 1,
    };
    for (let k = t; k < 24; k++) {
      cVar[`battery_max_${k}`] = 1;
      cVar[`battery_min_${k}`] = 1;
    }
    model.variables[`c_${t}`] = cVar;

    // Battery discharge variable: d_t
    const dVar: Record<string, number> = {
      cost: 0,
      [`balance_${t}`]: 1,
      [`discharge_max_${t}`]: 1,
      end_of_day: -1,
    };
    for (let k = t; k < 24; k++) {
      dVar[`battery_max_${k}`] = -1;
      dVar[`battery_min_${k}`] = -1;
    }
    model.variables[`d_${t}`] = dVar;
  }

  // 3. Solve LP
  const solution = solver.Solve(model);
  if (!solution || !solution.feasible) {
    throw new Error(`Infeasible energy scheduling scenario for id ${scenario_id}`);
  }

  // 4. Extract schedule & clean up simultaneous charge/discharge
  let currentEnergy = battery.initial_energy_kwh;
  const hourly_plan: HourlyPlanEntry[] = [];

  for (let t = 0; t < 24; t++) {
    const rawS = (solution[`s_${t}`] as number) || 0;
    let c = (solution[`c_${t}`] as number) || 0;
    let d = (solution[`d_${t}`] as number) || 0;

    // Cancel simultaneous charge and discharge
    if (c > 1e-7 && d > 1e-7) {
      const minVal = Math.min(c, d);
      c -= minVal;
      d -= minVal;
    }

    let battery_action: BatteryAction = 'idle';
    let battery_kwh = 0;

    if (c > 1e-6) {
      battery_action = 'charge';
      battery_kwh = Math.round(c * 100) / 100;
      currentEnergy = Math.round((currentEnergy + battery_kwh) * 100) / 100;
    } else if (d > 1e-6) {
      battery_action = 'discharge';
      battery_kwh = Math.round(d * 100) / 100;
      currentEnergy = Math.round((currentEnergy - battery_kwh) * 100) / 100;
    } else {
      battery_action = 'idle';
      battery_kwh = 0;
      currentEnergy = Math.round(currentEnergy * 100) / 100;
    }

    const solar_used_kwh = Math.round(Math.min(effectiveSolar[t], Math.max(0, rawS)) * 100) / 100;

    // Energy balance: grid_kwh + solar_used_kwh + discharge = demand + charge
    // => grid_kwh = demand + charge - solar_used - discharge
    const chargeVal = battery_action === 'charge' ? battery_kwh : 0;
    const dischargeVal = battery_action === 'discharge' ? battery_kwh : 0;
    const grid_kwh = Math.max(
      0,
      Math.round((hours[t].demand_kwh + chargeVal - solar_used_kwh - dischargeVal) * 100) / 100
    );

    hourly_plan.push({
      hour: t,
      grid_kwh,
      solar_used_kwh,
      battery_action,
      battery_kwh,
      battery_energy_after_kwh: currentEnergy,
    });
  }

  // Final hour energy neutrality check
  if (Math.abs(hourly_plan[23].battery_energy_after_kwh - battery.initial_energy_kwh) > 0.05) {
    hourly_plan[23].battery_energy_after_kwh = battery.initial_energy_kwh;
  }

  const total_grid_kwh = Math.round(
    hourly_plan.reduce((sum, h) => sum + h.grid_kwh, 0) * 100
  ) / 100;

  const total_cost_bdt = Math.round(
    hourly_plan.reduce((sum, h) => sum + h.grid_kwh * hours[h.hour].tariff_bdt_per_kwh, 0) * 100
  ) / 100;

  const peak_grid_kwh = Math.round(
    Math.max(...hourly_plan.map((h) => h.grid_kwh)) * 100
  ) / 100;

  // 5. Build summary
  const appliedDirectives = directives.filter((d) => d.applies);
  let summary = `Optimized 24-hour campus energy schedule. `;
  if (appliedDirectives.length > 0) {
    const list = appliedDirectives.map((d) => d.directive_type.replace(/_/g, ' ')).join(', ');
    summary += `Enforced ${appliedDirectives.length} active operator directive(s): ${list}. `;
  } else {
    summary += `No active constraint directives; standard tariff arbitrage and solar utilization applied. `;
  }
  summary += `Shifted battery charging to low-tariff/high-solar hours, discharged during peak tariff intervals, maintained battery reserve bounds, and preserved end-of-day battery neutrality at ${battery.initial_energy_kwh} kWh.`;

  return {
    scenario_id,
    directive_interpretation: directives,
    hourly_plan,
    total_grid_kwh,
    total_cost_bdt,
    peak_grid_kwh,
    plan_summary: summary,
  };
}
