import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase.js';

const SLA_TARGET = 99.9;
const PAGE_SIZE = 50;

export default function DashboardPage() {
  const [statsOpen, setStatsOpen] = useState(true);
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(0);
  const [totalLogs, setTotalLogs] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);

  const loadStats = useCallback(async () => {
    // Default window: everything. If dates are set, stats reflect that same window
    // as the logs below, so the two panels always describe the same slice of data.
    const from = dateFrom ? new Date(dateFrom).toISOString() : '1970-01-01T00:00:00Z';
    const to = dateTo
      ? new Date(new Date(dateTo).getTime() + 86400000).toISOString() // end of day, inclusive
      : '2100-01-01T00:00:00Z';

    const { data, error } = await supabase.rpc('service_stats', { from_ts: from, to_ts: to });
    if (error) setStatsError(error.message);
    else {
      setStats(data);
      setStatsError(null);
    }
  }, [dateFrom, dateTo]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    let query = supabase
      .from('checks')
      .select('id, service_id, ts, status_code, latency_ms, agent, region, is_error', { count: 'exact' })
      .order('ts', { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (dateFrom) query = query.gte('ts', new Date(dateFrom).toISOString());
    if (dateTo) query = query.lt('ts', new Date(new Date(dateTo).getTime() + 86400000).toISOString());

    const { data, count, error } = await query;
    if (!error) {
      setLogs(data ?? []);
      setTotalLogs(count ?? 0);
    }
    setLogsLoading(false);
  }, [dateFrom, dateTo, page]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadLogs(); }, [loadLogs]);
  // Any date-filter change resets pagination back to page 0.
  useEffect(() => { setPage(0); }, [dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(totalLogs / PAGE_SIZE));

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
          <span>Service availability {dateFrom || dateTo ? '(filtered range)' : '(all time)'}</span>
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

      {/* Logs panel */}
      <section className="border border-line bg-panel">
        <div className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-4">
          <div>
            <label className="block text-xs text-muted">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 border border-line bg-base px-2 py-1 text-sm text-ink"
            />
          </div>
          <div>
            <label className="block text-xs text-muted">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 border border-line bg-base px-2 py-1 text-sm text-ink"
            />
          </div>
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="border border-line px-3 py-1 text-xs text-muted hover:text-ink"
            >
              Clear
            </button>
          )}
          <span className="ml-auto text-xs text-muted">
            {totalLogs.toLocaleString()} check{totalLogs === 1 ? '' : 's'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="px-5 py-2 font-normal">Timestamp (UTC)</th>
                <th className="px-3 py-2 font-normal">Service</th>
                <th className="px-3 py-2 font-normal">Status</th>
                <th className="px-3 py-2 font-normal">Latency</th>
                <th className="px-3 py-2 font-normal">Agent</th>
                <th className="px-5 py-2 font-normal">Region</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {logsLoading && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-muted">Loading…</td></tr>
              )}
              {!logsLoading && logs.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-6 text-center text-muted">No checks in this window.</td></tr>
              )}
              {!logsLoading && logs.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-5 py-2 text-ink">{row.ts.replace('T', ' ').replace('.000Z', '')}</td>
                  <td className="px-3 py-2 text-ink">{row.service_id}</td>
                  <td className={`px-3 py-2 ${row.is_error ? 'text-bad' : 'text-ok'}`}>{row.status_code}</td>
                  <td className="px-3 py-2 text-muted">
                    {row.latency_ms === null ? '—' : `${Math.round(row.latency_ms)}ms`}
                  </td>
                  <td className="px-3 py-2 text-muted">{row.agent}</td>
                  <td className="px-5 py-2 text-muted">{row.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-muted">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="disabled:opacity-30"
          >
            ← Prev
          </button>
          <span>Page {page + 1} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="disabled:opacity-30"
          >
            Next →
          </button>
        </div>
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
