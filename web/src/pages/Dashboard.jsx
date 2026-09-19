import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';

const SLA_TARGET = 99.9;

export default function DashboardPage() {
  const [statsOpen, setStatsOpen] = useState(true);
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);

  const loadStats = useCallback(async () => {
    // Default window: everything. If dates are set, stats reflect that same window
    // as the logs below, so the two panels always describe the same slice of data.
    const from = '1970-01-01T00:00:00Z';
    const to = '2100-01-01T00:00:00Z';

    const { data, error } = await supabase.rpc('service_stats', { from_ts: from, to_ts: to });
    if (error) {
      setStatsError(error.message);
    }
    else {
      setStats(data);
      setStatsError(null);
    }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-8 flex items-baseline justify-between">
        <div>
          <p className="text-sm text-muted">SLA Monitoring</p>
          <h1 className="mt-1 text-2xl text-ink">Dashboard</h1>
        </div>
        <a href="/" className="text-xs text-muted underline hover:text-ink">
          ← Upload another file
        </a>
      </div>

      {/* Stats panel */}
      <section className="mb-8 border border-line bg-panel">
        <button
          onClick={() => setStatsOpen((v) => !v)}
          className="flex w-full items-center justify-between px-5 py-3 text-left text-sm text-ink"
        >
          <span>Service availability all time</span>
          <span className="text-muted">{statsOpen ? '−' : '+'}</span>
        </button>

        {statsOpen && (
          <div className="border-t border-line">
            {statsError && <p className="px-5 py-4 text-sm text-bad">{statsError}</p>}
            {!statsError && !stats && <p className="px-5 py-4 text-sm text-muted">Loading…</p>}
            {!statsError && stats && stats.length === 0 && (
              <p className="px-5 py-4 text-sm text-muted">No data in this window yet.</p>
            )}
            {!statsError && stats && stats.length > 0 && (
              <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-3">
                {stats.map((s) => (
                  <StatTile key={s.service_id} stat={s} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function StatTile({ stat }) {
  const breach = stat.uptime_pct < SLA_TARGET;
  return (
    <div className="px-5 py-4">
      <p className="text-sm text-ink">{stat.service_name}</p>
      <p className="mt-2 font-mono text-2xl" style={{ color: breach ? '#E5484D' : '#4CC38A' }}>
        {stat.uptime_pct?.toFixed(3) ?? '—'}%
      </p>
      <p className="text-xs text-muted">
        uptime {breach && <span className="text-bad">· SLA breach (target {SLA_TARGET}%)</span>}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
        <span>{stat.total_checks.toLocaleString()} checks</span>
        <span>{stat.error_checks.toLocaleString()} errors</span>
        <span>avg {stat.avg_latency_ms ? `${Math.round(stat.avg_latency_ms)}ms` : '—'}</span>
        <span>p95 {stat.p95_latency_ms ? `${Math.round(stat.p95_latency_ms)}ms` : '—'}</span>
      </div>
    </div>
  );
}
