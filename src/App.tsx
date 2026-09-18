import React, { useState, useEffect } from 'react';
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  Zap,
  Battery,
  Cpu,
  Copy,
  Check,
  Play,
  RefreshCw,
  Sliders,
  ShieldCheck,
  TrendingDown,
  Info,
} from 'lucide-react';
import { SAMPLE_CASES } from './server/sampleCases';
import { OptimizationResponse, HourlyPlanEntry } from './server/types';

export default function App() {
  const [selectedCaseId, setSelectedCaseId] = useState<string>('SAMPLE-01');
  const [healthStatus, setHealthStatus] = useState<{ ok: boolean; latency: number | null; checking: boolean }>({
    ok: false,
    latency: null,
    checking: true,
  });

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [runTimeMs, setRunTimeMs] = useState<number | null>(null);
  const [response, setResponse] = useState<OptimizationResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedJson, setCopiedJson] = useState<boolean>(false);

  // Custom editor state
  const [isCustomMode, setIsCustomMode] = useState<boolean>(false);
  const [customJsonText, setCustomJsonText] = useState<string>('');

  const currentCase = SAMPLE_CASES.find((c) => c.id === selectedCaseId) || SAMPLE_CASES[0];

  // Ping health endpoint
  const checkHealth = async () => {
    setHealthStatus((prev) => ({ ...prev, checking: true }));
    const t0 = performance.now();
    try {
      const res = await fetch('/health');
      const data = await res.json();
      const t1 = performance.now();
      if (res.ok && data.status === 'ok') {
        setHealthStatus({ ok: true, latency: Math.round(t1 - t0), checking: false });
      } else {
        setHealthStatus({ ok: false, latency: null, checking: false });
      }
    } catch {
      setHealthStatus({ ok: false, latency: null, checking: false });
    }
  };

  useEffect(() => {
    checkHealth();
  }, []);

  // Run optimization
  const executeOptimization = async (overridePayload?: any) => {
    setIsRunning(true);
    setErrorMsg(null);
    const t0 = performance.now();

    try {
      let payload;
      if (overridePayload) {
        payload = overridePayload;
      } else if (isCustomMode) {
        payload = JSON.parse(customJsonText);
      } else {
        payload = currentCase.input;
      }

      const res = await fetch('/optimize-energy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      const t1 = performance.now();
      setRunTimeMs(Math.round(t1 - t0));

      if (!res.ok) {
        setErrorMsg(data.error || data.message || `HTTP ${res.status} Error`);
      } else {
        setResponse(data);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error or invalid JSON format');
    } finally {
      setIsRunning(false);
    }
  };

  // Run sample on initial load
  useEffect(() => {
    executeOptimization(currentCase.input);
  }, [selectedCaseId, isCustomMode]);

  const handleSelectCase = (id: string) => {
    setIsCustomMode(false);
    setSelectedCaseId(id);
  };

  const handleOpenCustomMode = () => {
    setIsCustomMode(true);
    setCustomJsonText(JSON.stringify(currentCase.input, null, 2));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans antialiased selection:bg-cyan-500 selection:text-white">
      {/* Header Bar */}
      <header className="border-b border-slate-800/80 bg-slate-900/90 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-emerald-500 flex items-center justify-center shadow-lg shadow-cyan-900/30">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-white tracking-tight">GridWise API</h1>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-cyan-950 text-cyan-400 border border-cyan-800/60">
                  v2.0 Prelim
                </span>
              </div>
              <p className="text-xs text-slate-400">Smart Campus Energy Optimization</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Live Health Indicator */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs">
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  healthStatus.ok ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'
                }`}
              />
              <span className="font-mono text-slate-300">
                GET /health: {healthStatus.ok ? `200 OK (${healthStatus.latency}ms)` : 'Offline'}
              </span>
              <button
                onClick={checkHealth}
                title="Recheck Health"
                className="text-slate-400 hover:text-cyan-400 transition-colors ml-1 p-0.5"
              >
                <RefreshCw className={`w-3 h-3 ${healthStatus.checking ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area - API Console & Tester */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="space-y-6">
            {/* Scenario Picker Bar */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Challenge Sample Cases (10 Pack)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleOpenCustomMode}
                    className={`px-3 py-1 text-xs font-medium rounded-lg border transition-all ${
                      isCustomMode
                        ? 'bg-cyan-600 text-white border-cyan-500'
                        : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
                    }`}
                  >
                    Custom JSON Mode
                  </button>
                  <button
                    onClick={() => executeOptimization()}
                    disabled={isRunning}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-md shadow-cyan-900/20 transition-all cursor-pointer"
                  >
                    {isRunning ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Optimizing...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Run Optimization</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Case Chips */}
              <div className="flex flex-wrap gap-2">
                {SAMPLE_CASES.map((sc) => {
                  const isSelected = !isCustomMode && sc.id === selectedCaseId;
                  return (
                    <button
                      key={sc.id}
                      onClick={() => handleSelectCase(sc.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all text-left flex items-center gap-1.5 border ${
                        isSelected
                          ? 'bg-cyan-950/80 border-cyan-500 text-cyan-200 font-bold shadow-sm shadow-cyan-950'
                          : 'bg-slate-800/60 border-slate-700/60 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                      }`}
                    >
                      <span>{sc.id}</span>
                      <span className="text-[10px] text-slate-400 font-sans hidden sm:inline">
                        · {sc.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom JSON Editor if in Custom Mode */}
            {isCustomMode && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-cyan-400">
                    Input Payload (POST /optimize-energy)
                  </span>
                  <button
                    onClick={() => {
                      try {
                        setCustomJsonText(JSON.stringify(JSON.parse(customJsonText), null, 2));
                      } catch {}
                    }}
                    className="text-xs text-slate-400 hover:text-slate-200"
                  >
                    Format JSON
                  </button>
                </div>
                <textarea
                  value={customJsonText}
                  onChange={(e) => setCustomJsonText(e.target.value)}
                  rows={10}
                  className="w-full bg-slate-950 font-mono text-xs text-slate-200 p-3 rounded-xl border border-slate-800 focus:outline-none focus:border-cyan-500"
                />
              </div>
            )}

            {/* Current Scenario Info */}
            {!isCustomMode && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Operator Notes Box */}
                <div className="lg:col-span-2 bg-slate-900/70 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-cyan-400" />
                        <h2 className="text-sm font-semibold text-white">
                          Scenario {currentCase.id}: {currentCase.label}
                        </h2>
                      </div>
                      <span className="text-xs text-slate-400 italic font-mono">
                        {currentCase.input.operator_notes.length} note(s) to interpret
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mb-3">{currentCase.rationale}</p>
                    <div className="space-y-2">
                      {currentCase.input.operator_notes.map((note, idx) => (
                        <div
                          key={idx}
                          className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 flex items-start gap-3"
                        >
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-cyan-950 text-cyan-400 border border-cyan-800">
                            Note {idx}
                          </span>
                          <p className="text-xs text-slate-200 leading-relaxed">"{note}"</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Battery Specs Box */}
                <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Battery className="w-4 h-4 text-emerald-400" />
                      <h3 className="text-sm font-semibold text-white">Battery Specifications</h3>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/60">
                        <div className="text-slate-400 text-[10px]">Total Capacity</div>
                        <div className="text-base font-bold font-mono text-emerald-400">
                          {currentCase.input.battery.capacity_kwh} kWh
                        </div>
                      </div>
                      <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/60">
                        <div className="text-slate-400 text-[10px]">Initial SoC</div>
                        <div className="text-base font-bold font-mono text-cyan-400">
                          {currentCase.input.battery.initial_energy_kwh} kWh
                        </div>
                      </div>
                      <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/60">
                        <div className="text-slate-400 text-[10px]">Base Reserve</div>
                        <div className="text-sm font-semibold font-mono text-amber-400">
                          {currentCase.input.battery.minimum_energy_kwh} kWh
                        </div>
                      </div>
                      <div className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/60">
                        <div className="text-slate-400 text-[10px]">Max Charge Rate</div>
                        <div className="text-sm font-semibold font-mono text-slate-200">
                          {currentCase.input.battery.max_charge_kwh_per_hour} kWh/h
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 pt-2 border-t border-slate-800/80 text-[11px] text-slate-400 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Neutrality Rule: E(hour 23) must return to {currentCase.input.battery.initial_energy_kwh} kWh</span>
                  </div>
                </div>
              </div>
            )}

            {/* Error Message if any */}
            {errorMsg && (
              <div className="p-4 rounded-2xl bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Results Section */}
            {response && (
              <div className="space-y-6">
                {/* Metric Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gradient-to-b from-slate-900 to-slate-900/90 border border-cyan-800/40 rounded-2xl p-4 shadow-lg shadow-cyan-950/20">
                    <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                      <span>Total Grid Cost</span>
                      <TrendingDown className="w-3.5 h-3.5 text-cyan-400" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-white tracking-tight">
                      {response.total_cost_bdt.toLocaleString()} <span className="text-xs font-normal text-cyan-400">BDT</span>
                    </div>
                    {currentCase.expected_output && (
                      <div className="text-[11px] text-emerald-400 mt-1 font-mono flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Optimal Reference: {currentCase.expected_output.total_cost_bdt} BDT</span>
                      </div>
                    )}
                  </div>

                  <div className="bg-gradient-to-b from-slate-900 to-slate-900/90 border border-slate-800 rounded-2xl p-4">
                    <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                      <span>Total Grid Import</span>
                      <Zap className="w-3.5 h-3.5 text-amber-400" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-white tracking-tight">
                      {response.total_grid_kwh.toLocaleString()} <span className="text-xs font-normal text-amber-400">kWh</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1 font-mono">
                      Over 24 hourly intervals
                    </div>
                  </div>

                  <div className="bg-gradient-to-b from-slate-900 to-slate-900/90 border border-slate-800 rounded-2xl p-4">
                    <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                      <span>Peak Hourly Import</span>
                      <Activity className="w-3.5 h-3.5 text-violet-400" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-white tracking-tight">
                      {response.peak_grid_kwh} <span className="text-xs font-normal text-violet-400">kWh</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1 font-mono">
                      Max hourly campus grid load
                    </div>
                  </div>

                  <div className="bg-gradient-to-b from-slate-900 to-slate-900/90 border border-emerald-900/40 rounded-2xl p-4">
                    <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                      <span>Battery Neutrality</span>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    </div>
                    <div className="text-2xl font-bold font-mono text-emerald-400 tracking-tight">
                      {response.hourly_plan[23]?.battery_energy_after_kwh} <span className="text-xs font-normal">kWh</span>
                    </div>
                    <div className="text-[11px] text-emerald-400/90 mt-1 font-mono flex items-center gap-1">
                      <span>100% Equal to Initial Level</span>
                    </div>
                  </div>
                </div>

                {/* Plan Summary Banner */}
                <div className="p-3.5 rounded-2xl bg-cyan-950/30 border border-cyan-800/40 text-xs text-slate-200 flex items-start gap-2.5">
                  <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-cyan-300 mr-1">Plan Summary:</span>
                    <span>{response.plan_summary}</span>
                    {runTimeMs !== null && (
                      <span className="text-slate-400 text-[10px] ml-2 font-mono">
                        (Executed in {runTimeMs}ms)
                      </span>
                    )}
                  </div>
                </div>

                {/* Directive Interpretation Panel */}
                <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-cyan-400" />
                      <h3 className="text-sm font-semibold text-white">
                        LLM Directive Interpretation (Machine-Checked Output)
                      </h3>
                    </div>
                    <span className="text-[11px] text-slate-400 font-mono">
                      directive_interpretation [{response.directive_interpretation.length}]
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {response.directive_interpretation.map((d, i) => (
                      <div
                        key={i}
                        className={`p-3.5 rounded-xl border flex flex-col justify-between ${
                          d.applies
                            ? 'bg-slate-950/80 border-cyan-800/60 shadow-sm shadow-cyan-950'
                            : 'bg-slate-950/40 border-slate-800 text-slate-400'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300">
                                Note {d.note_index}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                                  d.applies
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                    : 'bg-slate-800 text-slate-400'
                                }`}
                              >
                                {d.applies ? 'Applies = true' : 'Applies = false (no_op)'}
                              </span>
                            </div>
                            <span className="font-mono text-xs font-semibold text-cyan-400">
                              {d.directive_type}
                            </span>
                          </div>

                          <p className="text-xs text-slate-300 mb-2 italic">"{d.explanation}"</p>

                          {d.structured_adjustment && (
                            <div className="bg-slate-900/90 rounded-lg p-2 font-mono text-xs space-y-1 border border-slate-800">
                              <div className="text-slate-400 text-[10px]">structured_adjustment:</div>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-slate-400">hours:</span>
                                <span className="text-cyan-300">
                                  [{d.structured_adjustment.hours.join(', ')}]
                                </span>
                              </div>
                              {'factor' in d.structured_adjustment && (
                                <div>
                                  <span className="text-slate-400">factor: </span>
                                  <span className="text-emerald-400 font-bold">
                                    {d.structured_adjustment.factor} (
                                    {(d.structured_adjustment.factor * 100).toFixed(0)}% usable)
                                  </span>
                                </div>
                              )}
                              {'minimum_energy_kwh' in d.structured_adjustment && (
                                <div>
                                  <span className="text-slate-400">minimum_energy_kwh: </span>
                                  <span className="text-amber-400 font-bold">
                                    {d.structured_adjustment.minimum_energy_kwh} kWh
                                  </span>
                                </div>
                              )}
                              {'max_grid_kwh' in d.structured_adjustment && (
                                <div>
                                  <span className="text-slate-400">max_grid_kwh: </span>
                                  <span className="text-rose-400 font-bold">
                                    {d.structured_adjustment.max_grid_kwh} kWh
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 24-Hour Energy Scheduling Visual Timeline */}
                <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white">24-Hour Schedule Breakdown</h3>
                      <p className="text-xs text-slate-400">
                        Hourly balance: Grid + Solar + Battery Discharge = Campus Demand + Battery Charge
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded bg-sky-500" />
                        <span className="text-slate-300">Grid Import</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded bg-amber-400" />
                        <span className="text-slate-300">Solar Used</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded bg-emerald-500" />
                        <span className="text-slate-300">Charge</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded bg-rose-500" />
                        <span className="text-slate-300">Discharge</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded bg-purple-400" />
                        <span className="text-slate-300">Battery SoC</span>
                      </div>
                    </div>
                  </div>

                  {/* Hourly Bars Visualization */}
                  <div className="space-y-1 overflow-x-auto pb-2">
                    <div className="min-w-[700px]">
                      <div className="grid grid-cols-24 gap-1 mb-2 text-center text-[10px] font-mono text-slate-400 border-b border-slate-800 pb-1">
                        {Array.from({ length: 24 }).map((_, h) => (
                          <span key={h}>{h}</span>
                        ))}
                      </div>

                      {/* Visual Chart Rows */}
                      <div className="h-44 flex items-end gap-1 bg-slate-950/60 p-2 rounded-xl border border-slate-800/80">
                        {response.hourly_plan.map((entry) => {
                          const maxDem = Math.max(
                            ...currentCase.input.hours.map((h) => h.demand_kwh),
                            220
                          );
                          const gridH = (entry.grid_kwh / maxDem) * 100;
                          const solarH = (entry.solar_used_kwh / maxDem) * 100;
                          const isCharge = entry.battery_action === 'charge';
                          const isDischarge = entry.battery_action === 'discharge';

                          return (
                            <div
                              key={entry.hour}
                              className="flex-1 h-full flex flex-col justify-end items-center group relative cursor-pointer"
                            >
                              {/* Hover Tooltip */}
                              <div className="absolute bottom-full mb-2 hidden group-hover:block z-30 w-44 bg-slate-900 border border-slate-700 text-[10px] p-2.5 rounded-lg shadow-xl pointer-events-none">
                                <div className="font-bold text-white border-b border-slate-800 pb-1 mb-1 font-mono">
                                  Hour {entry.hour}:00
                                </div>
                                <div className="text-sky-400">Grid: {entry.grid_kwh} kWh</div>
                                <div className="text-amber-400">Solar: {entry.solar_used_kwh} kWh</div>
                                <div className={isCharge ? 'text-emerald-400' : isDischarge ? 'text-rose-400' : 'text-slate-400'}>
                                  Battery: {entry.battery_action} ({entry.battery_kwh} kWh)
                                </div>
                                <div className="text-purple-400 font-semibold mt-1">
                                  SoC After: {entry.battery_energy_after_kwh} kWh
                                </div>
                              </div>

                              {/* Stacked representation */}
                              <div className="w-full flex flex-col justify-end items-center h-full">
                                {isCharge && (
                                  <div
                                    style={{ height: `${(entry.battery_kwh / maxDem) * 60}%` }}
                                    className="w-full bg-emerald-500/80 rounded-t-sm"
                                  />
                                )}
                                <div
                                  style={{ height: `${gridH}%` }}
                                  className="w-full bg-sky-500 rounded-t-sm"
                                />
                                <div
                                  style={{ height: `${solarH}%` }}
                                  className="w-full bg-amber-400/90"
                                />
                              </div>

                              {/* Battery SoC Indicator Dot */}
                              <div
                                title={`SoC: ${entry.battery_energy_after_kwh} kWh`}
                                className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-1"
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 24-Hour Detailed Data Table */}
                <div className="bg-slate-900/70 border border-slate-800 rounded-2xl overflow-hidden">
                  <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">
                      Complete 24-Hour Optimization Schedule Table
                    </h3>
                    <button
                      onClick={() => copyToClipboard(JSON.stringify(response, null, 2))}
                      className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs rounded-lg border border-slate-700 transition-colors"
                    >
                      {copiedJson ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400">Copied!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy Response JSON</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full text-xs text-left font-mono">
                      <thead className="bg-slate-950/80 text-slate-400 uppercase text-[10px] tracking-wider sticky top-0 z-10 border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">Hour</th>
                          <th className="py-2.5 px-3">Demand (kWh)</th>
                          <th className="py-2.5 px-3">Tariff (BDT)</th>
                          <th className="py-2.5 px-3">Grid Import (kWh)</th>
                          <th className="py-2.5 px-3">Solar Used (kWh)</th>
                          <th className="py-2.5 px-3">Battery Action</th>
                          <th className="py-2.5 px-3">Battery Flow (kWh)</th>
                          <th className="py-2.5 px-3">Battery SoC (kWh)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 text-slate-300">
                        {response.hourly_plan.map((h: HourlyPlanEntry) => {
                          const hourInput = currentCase.input.hours[h.hour] || {
                            demand_kwh: 0,
                            tariff_bdt_per_kwh: 0,
                          };
                          return (
                            <tr
                              key={h.hour}
                              className="hover:bg-slate-800/40 transition-colors"
                            >
                              <td className="py-2 px-3 font-bold text-white">{h.hour}</td>
                              <td className="py-2 px-3">{hourInput.demand_kwh}</td>
                              <td className="py-2 px-3 text-amber-400 font-semibold">
                                {hourInput.tariff_bdt_per_kwh}
                              </td>
                              <td className="py-2 px-3 font-semibold text-sky-400">{h.grid_kwh}</td>
                              <td className="py-2 px-3 text-amber-300">{h.solar_used_kwh}</td>
                              <td className="py-2 px-3">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold ${
                                    h.battery_action === 'charge'
                                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                      : h.battery_action === 'discharge'
                                      ? 'bg-rose-950 text-rose-400 border border-rose-800/60'
                                      : 'bg-slate-800 text-slate-400'
                                  }`}
                                >
                                  {h.battery_action}
                                </span>
                              </td>
                              <td className="py-2 px-3">{h.battery_kwh}</td>
                              <td className="py-2 px-3 font-bold text-purple-400">
                                {h.battery_energy_after_kwh}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
      </main>
    </div>
  );
}
