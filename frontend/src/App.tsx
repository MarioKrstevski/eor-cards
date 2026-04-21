import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import WorkspacePage from './pages/WorkspacePage';
import LibraryPage from './pages/LibraryPage';

export default function App() {
  return (
    <BrowserRouter>
      <nav className="bg-white border-b border-gray-200 flex items-center gap-6 px-6 h-12 shrink-0">
        <span className="text-sm font-semibold text-gray-900 mr-2">Card Studio</span>
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            isActive
              ? 'text-sm font-medium text-violet-600'
              : 'text-sm text-gray-500 hover:text-gray-900 transition-colors'
          }
        >
          Workspace
        </NavLink>
        <NavLink
          to="/library"
          className={({ isActive }) =>
            isActive
              ? 'text-sm font-medium text-violet-600'
              : 'text-sm text-gray-500 hover:text-gray-900 transition-colors'
          }
        >
          Library
        </NavLink>
      </nav>
      <main className="bg-gray-50 min-h-[calc(100vh-48px)]">
        <Routes>
          <Route path="/" element={<WorkspacePage />} />
          <Route path="/library" element={<LibraryPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
