import { GoogleGenAI, Type } from '@google/genai';
import {
  BatteryInput,
  DirectiveInterpretation,
  DirectiveType,
  StructuredAdjustment,
} from './types.ts';

let genAIClient: GoogleGenAI | null = null;

function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (!genAIClient) {
    genAIClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return genAIClient;
}

/**
 * Deterministic helper to parse natural language hour ranges into unique sorted integers 0..23.
 * Convention: start is included, end is excluded.
 * e.g. "1 PM to 3 PM" -> 13 to 15 -> [13, 14]
 * "noon until 2 PM" -> 12 to 14 -> [12, 13]
 * "6 PM until 9 PM" -> 18 to 21 -> [18, 19, 20]
 * "2 AM until 5 AM" -> 2 to 5 -> [2, 3, 4]
 */
export function parseHourRangeFromText(text: string): number[] {
  const t = text.toLowerCase();

  // Try matching "noon until/to X PM"
  const noonMatch = t.match(/noon\s+(?:until|to|-)\s*(\d{1,2})(?::00)?\s*(am|pm)?/);
  if (noonMatch) {
    let end = parseInt(noonMatch[1], 10);
    const endMeridiem = noonMatch[2] || 'pm';
    if (endMeridiem === 'pm' && end < 12) end += 12;
    if (endMeridiem === 'am' && end === 12) end = 0;
    const hours: number[] = [];
    for (let h = 12; h < end && h < 24; h++) hours.push(h);
    if (hours.length > 0) return hours;
  }

  // Try matching "from/between X (AM|PM)? until/to/and Y (AM|PM)"
  const rangeMatch = t.match(/(?:from|between|during|at)?\s*(\d{1,2})(?::00)?\s*(am|pm)?\s*(?:until|to|and|-)\s*(\d{1,2})(?::00)?\s*(am|pm)/);
  if (rangeMatch) {
    let start = parseInt(rangeMatch[1], 10);
    const startMeridiem = rangeMatch[2];
    let end = parseInt(rangeMatch[3], 10);
    const endMeridiem = rangeMatch[4];

    // If start doesn't have meridiem, infer from end or context
    let effStartMeridiem = startMeridiem;
    if (!effStartMeridiem) {
      if (endMeridiem === 'pm') {
        if (start === 12) effStartMeridiem = 'pm';
        else if (start >= 1 && start <= 11) {
          // e.g. "11 AM until 1 PM" or "1 to 3 PM"
          if (start > end) effStartMeridiem = 'am'; // e.g. 11 to 1 PM -> 11 AM to 1 PM
          else effStartMeridiem = 'pm'; // e.g. 1 to 3 PM -> 1 PM to 3 PM
        }
      } else {
        effStartMeridiem = endMeridiem;
      }
    }

    if (effStartMeridiem === 'pm' && start < 12) start += 12;
    if (effStartMeridiem === 'am' && start === 12) start = 0;
    if (endMeridiem === 'pm' && end < 12) end += 12;
    if (endMeridiem === 'am' && end === 12) end = 0;

    const hours: number[] = [];
    for (let h = start; h < end && h < 24; h++) {
      hours.push(h);
    }
    if (hours.length > 0) return hours;
  }

  // Try matching 24-hour format: "13:00 and 15:00" or "13:00 to 15:00"
  const m24 = t.match(/(\d{1,2}):00\s*(?:and|to|until|-)\s*(\d{1,2}):00/);
  if (m24) {
    const start = parseInt(m24[1], 10);
    const end = parseInt(m24[2], 10);
    const hours: number[] = [];
    for (let h = start; h < end && h < 24; h++) hours.push(h);
    if (hours.length > 0) return hours;
  }

  return [];
}

/**
 * Fallback deterministic rule parser in case LLM is offline or malformed.
 */
export function fallbackRuleParser(note: string, noteIndex: number, battery: BatteryInput): DirectiveInterpretation {
  const text = note.toLowerCase();

  // Distractors / non-energy notes:
  const distractorWords = [
    'registration', 'sports', 'cafeteria', 'menu', 'library', 'book',
    'student affairs', 'notices', 'seminar', 'room booking', 'lecture', 'parking'
  ];
  if (distractorWords.some(w => text.includes(w))) {
    return {
      note_index: noteIndex,
      applies: false,
      directive_type: 'no_op',
      structured_adjustment: null,
      explanation: 'This note does not affect today\'s 24-hour energy schedule.'
    };
  }

  // Check for solar reduction
  if (text.includes('solar') || text.includes('pv') || text.includes('panel') || text.includes('cleaning') || text.includes('inverter')) {
    const hours = parseHourRangeFromText(note);
    let factor = 0.5;

    // Check percentage: e.g. "80% reduction" -> factor 0.2
    const redMatch = text.match(/(\d+)%\s*reduction/);
    if (redMatch) {
      const redPercent = parseFloat(redMatch[1]);
      factor = Math.max(0, Math.min(1, (100 - redPercent) / 100));
    } else {
      const dropMatch = text.match(/(?:drop to|leave|about|roughly)\s*(\d+)%/);
      if (dropMatch) {
        factor = parseFloat(dropMatch[1]) / 100;
      } else if (text.includes('one-fifth') || text.includes('1/5')) {
        factor = 0.2;
      } else if (text.includes('one-fourth') || text.includes('quarter') || text.includes('25%')) {
        factor = 0.25;
      } else if (text.includes('half') || text.includes('50%')) {
        factor = 0.5;
      }
    }

    if (hours.length > 0) {
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: 'solar_reduction',
        structured_adjustment: {
          hours,
          factor: Math.round(factor * 100) / 100
        },
        explanation: `Solar availability is reduced to ${(factor * 100).toFixed(0)}% during the stated hours.`
      };
    }
  }

  // Check for no_charge_window
  if ((text.includes('not charge') || text.includes('no charge') || text.includes('charging') || text.includes('charger')) &&
      (text.includes('isolate') || text.includes('maintenance') || text.includes('unavailable') || text.includes('disabled') || text.includes('outage') || text.includes('inspect'))) {
    const hours = parseHourRangeFromText(note);
    if (hours.length > 0) {
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: 'no_charge_window',
        structured_adjustment: { hours },
        explanation: 'Battery charging is unavailable during the maintenance window.'
      };
    }
  }

  // Check for no_discharge_window
  if (text.includes('not discharge') || text.includes('no discharge') || text.includes('discharging is disabled') || text.includes('relay testing') || text.includes('protection testing')) {
    const hours = parseHourRangeFromText(note);
    if (hours.length > 0) {
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: 'no_discharge_window',
        structured_adjustment: { hours },
        explanation: 'Battery discharging is disabled during the protection testing window.'
      };
    }
  }

  // Check for minimum_battery_reserve
  if (text.includes('reserve') || text.includes('stored in the battery') || text.includes('remain in the battery')) {
    const hours = parseHourRangeFromText(note);
    let minKwh = battery.minimum_energy_kwh;

    // Check relative percentage: "50% of the battery capacity"
    const pctMatch = text.match(/(\d+)%\s*(?:of)?\s*(?:the)?\s*battery/);
    if (pctMatch) {
      const pct = parseFloat(pctMatch[1]) / 100;
      minKwh = Math.round(pct * battery.capacity_kwh);
    } else {
      const kwhMatch = text.match(/(\d+(?:\.\d+)?)\s*kwh/);
      if (kwhMatch) {
        minKwh = parseFloat(kwhMatch[1]);
      }
    }

    if (hours.length > 0) {
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: 'minimum_battery_reserve',
        structured_adjustment: {
          hours,
          minimum_energy_kwh: minKwh
        },
        explanation: `A minimum battery reserve of ${minKwh} kWh is maintained during the stated window.`
      };
    }
  }

  // Check for max_grid_window
  if (text.includes('grid') && (text.includes('cap') || text.includes('exceed') || text.includes('limit') || text.includes('feeder') || text.includes('transformer') || text.includes('intake') || text.includes('import'))) {
    const hours = parseHourRangeFromText(note);
    let maxGridKwh = 1000;
    const kwhMatch = text.match(/(\d+(?:\.\d+)?)\s*kwh/);
    if (kwhMatch) {
      maxGridKwh = parseFloat(kwhMatch[1]);
    }

    if (hours.length > 0) {
      return {
        note_index: noteIndex,
        applies: true,
        directive_type: 'max_grid_window',
        structured_adjustment: {
          hours,
          max_grid_kwh: maxGridKwh
        },
        explanation: `Grid import is capped at ${maxGridKwh} kWh during the restricted window.`
      };
    }
  }

  return {
    note_index: noteIndex,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: null,
    explanation: 'This note does not affect today\'s 24-hour energy schedule.'
  };
}

/**
 * Guardrail and normalize raw LLM output against the competition specification.
 */
export function guardrailAndNormalize(
  rawList: unknown,
  operatorNotes: string[],
  battery: BatteryInput
): DirectiveInterpretation[] {
  const result: DirectiveInterpretation[] = [];

  const rawArray = Array.isArray(rawList) ? rawList : [];

  for (let i = 0; i < operatorNotes.length; i++) {
    const rawEntry = rawArray.find((item: any) => item && item.note_index === i) || rawArray[i];

    if (!rawEntry || typeof rawEntry !== 'object') {
      result.push(fallbackRuleParser(operatorNotes[i], i, battery));
      continue;
    }

    let directive_type: DirectiveType = rawEntry.directive_type;
    const allowedTypes: DirectiveType[] = [
      'solar_reduction',
      'minimum_battery_reserve',
      'no_charge_window',
      'no_discharge_window',
      'max_grid_window',
      'no_op',
    ];

    if (!allowedTypes.includes(directive_type)) {
      result.push(fallbackRuleParser(operatorNotes[i], i, battery));
      continue;
    }

    // Guardrail: no_op rules
    if (directive_type === 'no_op' || rawEntry.applies === false) {
      result.push({
        note_index: i,
        applies: false,
        directive_type: 'no_op',
        structured_adjustment: null,
        explanation: typeof rawEntry.explanation === 'string' && rawEntry.explanation.trim() !== ''
          ? rawEntry.explanation
          : 'This note does not affect today\'s energy schedule.'
      });
      continue;
    }

    // For non-no_op directives: applies MUST be true
    const applies = true;
    const adj = rawEntry.structured_adjustment;

    if (!adj || typeof adj !== 'object') {
      result.push(fallbackRuleParser(operatorNotes[i], i, battery));
      continue;
    }

    // Validate hours: must be unique integers 0..23 in ascending order
    let hours: number[] = [];
    if (Array.isArray(adj.hours)) {
      const parsed = (adj.hours as any[])
        .map((h: any) => Math.round(Number(h)))
        .filter((h: number) => !isNaN(h) && h >= 0 && h <= 23);
      hours = Array.from(new Set<number>(parsed)).sort((a, b) => a - b);
    }

    // If LLM returned empty hours, try fallback hours parsing
    if (hours.length === 0) {
      hours = parseHourRangeFromText(operatorNotes[i]);
    }

    if (hours.length === 0) {
      // Cannot apply directive without valid hours
      result.push({
        note_index: i,
        applies: false,
        directive_type: 'no_op',
        structured_adjustment: null,
        explanation: 'Could not determine applicable hour window.'
      });
      continue;
    }

    let structured_adjustment: StructuredAdjustment = null;

    if (directive_type === 'solar_reduction') {
      let factor = typeof adj.factor === 'number' ? adj.factor : 0.5;
      // If factor was given as percentage (e.g. 25 instead of 0.25)
      if (factor > 1 && factor <= 100) factor = factor / 100;
      // If note explicitly said "80% reduction" but LLM put factor = 0.8 instead of 0.2
      if (/(\d+)%\s*reduction/i.test(operatorNotes[i])) {
        const redMatch = operatorNotes[i].match(/(\d+)%\s*reduction/i);
        if (redMatch) {
          const redVal = parseFloat(redMatch[1]) / 100;
          factor = Math.round((1 - redVal) * 100) / 100;
        }
      }
      factor = Math.max(0, Math.min(1, factor));

      structured_adjustment = {
        hours,
        factor: Math.round(factor * 100) / 100
      };
    } else if (directive_type === 'minimum_battery_reserve') {
      let minKwh = typeof adj.minimum_energy_kwh === 'number' ? adj.minimum_energy_kwh : battery.minimum_energy_kwh;
      // If LLM output a ratio (e.g. 0.5 instead of 100 kWh for 50% capacity)
      if (minKwh <= 1 && battery.capacity_kwh > 10) {
        minKwh = minKwh * battery.capacity_kwh;
      }
      minKwh = Math.max(0, Math.min(battery.capacity_kwh, Math.round(minKwh * 100) / 100));

      structured_adjustment = {
        hours,
        minimum_energy_kwh: minKwh
      };
    } else if (directive_type === 'no_charge_window') {
      structured_adjustment = { hours };
    } else if (directive_type === 'no_discharge_window') {
      structured_adjustment = { hours };
    } else if (directive_type === 'max_grid_window') {
      const maxGrid = typeof adj.max_grid_kwh === 'number' && !isNaN(adj.max_grid_kwh)
        ? Math.max(0, Math.round(adj.max_grid_kwh * 100) / 100)
        : 155;
      structured_adjustment = {
        hours,
        max_grid_kwh: maxGrid
      };
    }

    result.push({
      note_index: i,
      applies,
      directive_type,
      structured_adjustment,
      explanation: typeof rawEntry.explanation === 'string' && rawEntry.explanation.trim() !== ''
        ? rawEntry.explanation
        : `Directive ${directive_type} applied for hours [${hours.join(', ')}].`
    });
  }

  return result;
}

/**
 * Interpret operator notes using Gemini 3.8 Flash, with deterministic guardrails and fallback.
 */
export async function interpretOperatorNotes(
  operatorNotes: string[],
  battery: BatteryInput
): Promise<DirectiveInterpretation[]> {
  const ai = getGenAI();

  if (!ai) {
    console.warn('[LLM Interpreter] GEMINI_API_KEY not found. Using deterministic parser.');
    return operatorNotes.map((note, idx) => fallbackRuleParser(note, idx, battery));
  }

  const prompt = `You are the energy operator note interpreter for BUP Smart Campus (GridWise challenge).
You must interpret each operator note into a machine-checkable structured directive according to strict competition rules:

SUPPORTED DIRECTIVE TYPES:
1. "solar_reduction":
   Meaning: Reduce usable rooftop solar during specific hours.
   Adjustment shape: {"hours": [array of unique integers 0..23 in ascending order], "factor": number between 0 and 1}
   CRITICAL: factor is the USABLE FRACTION REMAINING!
   Examples:
   - "Expect an 80% reduction in rooftop solar" -> factor = 0.2 (because 20% remains usable!)
   - "usable solar should be treated as roughly 25% of forecast" -> factor = 0.25
   - "leave about half of the forecast" -> factor = 0.5
   - "leave roughly one-fifth of normal output" -> factor = 0.2

2. "minimum_battery_reserve":
   Meaning: Keep battery energy at or above a required level during specific hours.
   Adjustment shape: {"hours": [array of unique integers 0..23 in ascending order], "minimum_energy_kwh": number in kWh}
   CRITICAL: If given as percentage, convert to absolute kWh using battery.capacity_kwh = ${battery.capacity_kwh}.
   Example: "Keep at least 50% of the battery capacity" with capacity ${battery.capacity_kwh} -> minimum_energy_kwh = ${0.5 * battery.capacity_kwh}.
   "Keep at least 90 kWh in the battery" -> minimum_energy_kwh = 90.

3. "no_charge_window":
   Meaning: Battery charging is unavailable / prohibited during specific hours.
   Adjustment shape: {"hours": [array of unique integers 0..23 in ascending order]}
   Examples: charger isolated, charging circuit offline, electrical maintenance.

4. "no_discharge_window":
   Meaning: Battery discharging is unavailable / prohibited during specific hours.
   Adjustment shape: {"hours": [array of unique integers 0..23 in ascending order]}
   Examples: protection testing, relay testing, discharge disabled.

5. "max_grid_window":
   Meaning: Grid import may not exceed a stated amount during specific hours.
   Adjustment shape: {"hours": [array of unique integers 0..23 in ascending order], "max_grid_kwh": number in kWh}
   Examples: feeder limit, transformer limit, grid intake cap.

6. "no_op":
   Meaning: The note does NOT affect the current 24-hour campus energy schedule (e.g. sports office deadlines, library hours, cafeteria menus, seminar bookings, unrelated campus announcements).
   For no_op: applies MUST be false, structured_adjustment MUST be null.

TIME WINDOW CONVENTION (CRITICAL):
All time windows use whole-hour intervals, start-inclusive and end-exclusive!
- "1 PM to 3 PM" or "between 1 PM and 3 PM" -> 13:00 to 15:00 -> hours: [13, 14]
- "noon until 2 PM" -> 12:00 to 14:00 -> hours: [12, 13]
- "2 AM until 5 AM" -> 2:00 to 5:00 -> hours: [2, 3, 4]
- "6 PM until 9 PM" -> 18:00 to 21:00 -> hours: [18, 19, 20]
- "6 PM until 10 PM" -> 18:00 to 22:00 -> hours: [18, 19, 20, 21]
- "7 PM until 10 PM" -> 19:00 to 22:00 -> hours: [19, 20, 21]
- "7 PM until 9 PM" -> 19:00 to 21:00 -> hours: [19, 20]
- "10 AM until noon" -> 10:00 to 12:00 -> hours: [10, 11]
- "11 AM until 1 PM" -> 11:00 to 13:00 -> hours: [11, 12]
- "11 AM until 2 PM" -> 11:00 to 14:00 -> hours: [11, 12, 13]
- "2 PM until 4 PM" -> 14:00 to 16:00 -> hours: [14, 15]
- "5 PM until 7 PM" -> 17:00 to 19:00 -> hours: [17, 18]

Notes to interpret (total ${operatorNotes.length}):
${operatorNotes.map((note, idx) => `[Note ${idx}]: "${note}"`).join('\n')}

Output a JSON array containing exactly ${operatorNotes.length} entries, corresponding to notes in order 0..${operatorNotes.length - 1}.`;

  try {
    // Timeout promise (7s max) to guarantee snappy response without hanging
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LLM request timed out after 7000ms')), 7000)
    );

    let response: any = null;
    try {
      const llmCall = ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                note_index: { type: Type.INTEGER },
                applies: { type: Type.BOOLEAN },
                directive_type: {
                  type: Type.STRING,
                  enum: [
                    'solar_reduction',
                    'minimum_battery_reserve',
                    'no_charge_window',
                    'no_discharge_window',
                    'max_grid_window',
                    'no_op',
                  ],
                },
                structured_adjustment: {
                  type: Type.OBJECT,
                  properties: {
                    hours: {
                      type: Type.ARRAY,
                      items: { type: Type.INTEGER },
                    },
                    factor: { type: Type.NUMBER },
                    minimum_energy_kwh: { type: Type.NUMBER },
                    max_grid_kwh: { type: Type.NUMBER },
                  },
                },
                explanation: { type: Type.STRING },
              },
              required: ['note_index', 'applies', 'directive_type', 'explanation'],
            },
          },
        },
      });
      response = await Promise.race([llmCall, timeoutPromise]);
    } catch (primaryErr: any) {
      console.warn(`[LLM Interpreter] Primary model error (${primaryErr?.message || primaryErr}), trying fallback model...`);
      try {
        const fallbackCall = ai.models.generateContent({
          model: 'gemini-flash-latest',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });
        response = await Promise.race([fallbackCall, timeoutPromise]);
      } catch (secondaryErr: any) {
        console.warn(`[LLM Interpreter] Secondary model unavailable (${secondaryErr?.message || secondaryErr}), using deterministic guardrail parser.`);
        return operatorNotes.map((note, idx) => fallbackRuleParser(note, idx, battery));
      }
    }

    const text = response?.text ? response.text.trim() : '';
    if (!text) {
      return operatorNotes.map((note, idx) => fallbackRuleParser(note, idx, battery));
    }

    const rawData = JSON.parse(text);
    return guardrailAndNormalize(rawData, operatorNotes, battery);
  } catch (error) {
    console.warn('[LLM Interpreter fallback to deterministic parser]:', (error as any)?.message || error);
    return operatorNotes.map((note, idx) => fallbackRuleParser(note, idx, battery));
  }
}
