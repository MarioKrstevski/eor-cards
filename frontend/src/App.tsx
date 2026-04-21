import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';

function WorkspacePage() {
  return <div>Workspace</div>;
}

function LibraryPage() {
  return <div>Library</div>;
}

export default function App() {
  return (
    <BrowserRouter>
      <nav style={{ display: 'flex', gap: '1rem', padding: '0.75rem 1rem', borderBottom: '1px solid #e5e7eb' }}>
        <NavLink to="/">Workspace</NavLink>
        <NavLink to="/library">Library</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<WorkspacePage />} />
          <Route path="/library" element={<LibraryPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
