import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth.jsx';
import Chrome from './components/Chrome.jsx';
import Home from './pages/Home.jsx';
import Search from './pages/Search.jsx';
import Card from './pages/Card.jsx';
import Expansion from './pages/Expansion.jsx';

export default function App() {
  return (
    <AuthProvider>
      <Chrome>
        <Routes>
          <Route path="/marketplace" element={<Home />} />
          <Route path="/marketplace/" element={<Home />} />
          <Route path="/marketplace/search" element={<Search />} />
          <Route path="/marketplace/search/" element={<Search />} />
          <Route path="/marketplace/sets/:slug" element={<Expansion />} />
          <Route path="/marketplace/sets/:slug/" element={<Expansion />} />
          <Route path="/marketplace/:lang/cards/:cardId/:slug" element={<Card />} />
          <Route path="/marketplace/:lang/cards/:cardId/:slug/" element={<Card />} />
          <Route path="/marketplace/:lang/cards/:cardId" element={<Card />} />
          <Route path="/marketplace/:lang/cards/:cardId/" element={<Card />} />
          <Route path="*" element={<Navigate to="/marketplace" replace />} />
        </Routes>
      </Chrome>
    </AuthProvider>
  );
}
