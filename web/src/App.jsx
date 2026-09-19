import { BrowserRouter, Routes, Route } from 'react-router-dom';
import UploadPage from './pages/Upload.jsx';
import DashboardPage from './pages/Dashboard.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
      </Routes>
    </BrowserRouter>
  );
}
