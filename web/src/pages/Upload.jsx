import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_URL } from '../lib/supabase.js';

export default function UploadPage() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | uploading | done | error
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const navigate = useNavigate();

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }, []);

  async function handleUpload() {
    if (!file) return;
    setStatus('uploading');
    setErrorMsg(null);
    try {
      const text = await file.text();
      const res = await fetch(`${API_URL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      });
      const body = await res.json();
      if (!res.ok) {
        setErrorMsg(body.error ?? `Upload failed (${res.status})`);
        setStatus('error');
        return;
      }
      setResult(body);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err.message);
      setStatus('error');
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="mb-10">
        <p className="text-sm text-muted">SLA Monitoring</p>
        <h1 className="mt-1 text-2xl text-ink">Upload health-check log</h1>
        <p className="mt-2 max-w-md text-sm text-muted">
          A CSV of 15-minute health checks across services. It gets parsed and
          validated in a cloud function, then stored for the dashboard.
        </p>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="rounded-none border border-dashed border-line bg-panel px-6 py-10 text-center"
      >
        <input
          id="file-input"
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <label htmlFor="file-input" className="cursor-pointer text-sm text-muted">
          {file ? (
            <span className="font-mono text-ink">{file.name}</span>
          ) : (
            <>Drop a CSV here, or <span className="text-accent underline">choose a file</span></>
          )}
        </label>
      </div>

      <button
        onClick={handleUpload}
        disabled={!file || status === 'uploading'}
        className="mt-6 w-full border border-line bg-accent/20 py-2.5 text-sm text-ink transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {status === 'uploading' ? 'Processing…' : 'Upload and process'}
      </button>

      {status === 'error' && (
        <p className="mt-4 text-sm text-bad">{errorMsg}</p>
      )}

      {status === 'done' && result && (
        <div className="mt-8 border border-line bg-panel p-5 text-sm">
          <p className="text-ink">
            Inserted <span className="font-mono text-ok">{result.inserted_count}</span> of{' '}
            <span className="font-mono">{result.raw_row_count}</span> rows
            {result.dropped_count > 0 && (
              <> — <span className="font-mono text-warn">{result.dropped_count}</span> dropped</>
            )}
          </p>
          {result.issue_count > 0 && (
            <p className="mt-1 text-muted">
              {result.issue_count} row{result.issue_count === 1 ? '' : 's'} had a data-quality
              issue (see the API response in devtools for the full list).
            </p>
          )}
          <button
            onClick={() => navigate('/dashboard')}
            className="mt-4 border border-line px-4 py-1.5 text-xs text-ink hover:bg-line/40"
          >
            View dashboard →
          </button>
        </div>
      )}
    </main>
  );
}
