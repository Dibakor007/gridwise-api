export type DirectiveType =
  | 'solar_reduction'
  | 'minimum_battery_reserve'
  | 'no_charge_window'
  | 'no_discharge_window'
  | 'max_grid_window'
  | 'no_op';

export type BatteryAction = 'charge' | 'discharge' | 'idle';

export interface SolarReductionAdjustment {
  hours: number[];
  factor: number;
}

export interface MinimumBatteryReserveAdjustment {
  hours: number[];
  minimum_energy_kwh: number;
}

export interface NoChargeWindowAdjustment {
  hours: number[];
}

export interface NoDischargeWindowAdjustment {
  hours: number[];
}

export interface MaxGridWindowAdjustment {
  hours: number[];
  max_grid_kwh: number;
}

export type StructuredAdjustment =
  | SolarReductionAdjustment
  | MinimumBatteryReserveAdjustment
  | NoChargeWindowAdjustment
  | NoDischargeWindowAdjustment
  | MaxGridWindowAdjustment
  | null;

export interface DirectiveInterpretation {
  note_index: number;
  applies: boolean;
  directive_type: DirectiveType;
  structured_adjustment: StructuredAdjustment;
  explanation: string;
}

export interface HourInput {
  hour: number;
  demand_kwh: number;
  solar_kwh: number;
  tariff_bdt_per_kwh: number;
}

export interface BatteryInput {
  capacity_kwh: number;
  initial_energy_kwh: number;
  minimum_energy_kwh: number;
  max_charge_kwh_per_hour: number;
  max_discharge_kwh_per_hour: number;
}

export interface OptimizationRequest {
  scenario_id: string;
  operator_notes: string[];
  hours: HourInput[];
  battery: BatteryInput;
}

export interface HourlyPlanEntry {
  hour: number;
  grid_kwh: number;
  solar_used_kwh: number;
  battery_action: BatteryAction;
  battery_kwh: number;
  battery_energy_after_kwh: number;
}

export interface OptimizationResponse {
  scenario_id: string;
  directive_interpretation: DirectiveInterpretation[];
  hourly_plan: HourlyPlanEntry[];
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
  plan_summary: string;
}

export function validateRequest(body: unknown): { valid: boolean; error?: string; data?: OptimizationRequest } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a valid JSON object' };
  }

  const req = body as Partial<OptimizationRequest>;

  if (typeof req.scenario_id !== 'string' || req.scenario_id.trim() === '') {
    return { valid: false, error: 'Field "scenario_id" must be a non-empty string' };
  }

  if (!Array.isArray(req.operator_notes) || req.operator_notes.length < 1 || req.operator_notes.length > 3) {
    return { valid: false, error: 'Field "operator_notes" must be an array of 1 to 3 non-empty strings' };
  }

  for (let i = 0; i < req.operator_notes.length; i++) {
    if (typeof req.operator_notes[i] !== 'string' || req.operator_notes[i].trim() === '') {
      return { valid: false, error: `operator_notes[${i}] must be a non-empty string` };
    }
  }

  if (!Array.isArray(req.hours) || req.hours.length !== 24) {
    return { valid: false, error: 'Field "hours" must contain exactly 24 hour entries (0 through 23)' };
  }

  const seenHours = new Set<number>();
  for (let i = 0; i < 24; i++) {
    const h = req.hours[i];
    if (!h || typeof h.hour !== 'number' || h.hour !== i) {
      return { valid: false, error: `hours[${i}] must have "hour" equal to ${i}` };
    }
    seenHours.add(h.hour);
    if (typeof h.demand_kwh !== 'number' || isNaN(h.demand_kwh) || h.demand_kwh < 0) {
      return { valid: false, error: `hours[${i}].demand_kwh must be a non-negative number` };
    }
    if (typeof h.solar_kwh !== 'number' || isNaN(h.solar_kwh) || h.solar_kwh < 0) {
      return { valid: false, error: `hours[${i}].solar_kwh must be a non-negative number` };
    }
    if (typeof h.tariff_bdt_per_kwh !== 'number' || isNaN(h.tariff_bdt_per_kwh) || h.tariff_bdt_per_kwh < 0) {
      return { valid: false, error: `hours[${i}].tariff_bdt_per_kwh must be a non-negative number` };
    }
  }

  if (!req.battery || typeof req.battery !== 'object') {
    return { valid: false, error: 'Field "battery" must be a valid object' };
  }

  const b = req.battery;
  const numFields: (keyof BatteryInput)[] = [
    'capacity_kwh',
    'initial_energy_kwh',
    'minimum_energy_kwh',
    'max_charge_kwh_per_hour',
    'max_discharge_kwh_per_hour',
  ];

  for (const f of numFields) {
    if (typeof b[f] !== 'number' || isNaN(b[f]) || b[f] < 0) {
      return { valid: false, error: `battery.${f} must be a non-negative number` };
    }
  }

  if (b.minimum_energy_kwh > b.capacity_kwh) {
    return { valid: false, error: 'battery.minimum_energy_kwh cannot exceed capacity_kwh' };
  }

  if (b.initial_energy_kwh > b.capacity_kwh || b.initial_energy_kwh < b.minimum_energy_kwh) {
    return { valid: false, error: 'battery.initial_energy_kwh must be between minimum_energy_kwh and capacity_kwh' };
  }

  return { valid: true, data: req as OptimizationRequest };
}
