import { BrowserRouter, Routes, Route } from 'react-router-dom';
import GiveawayPage from './pages/GiveawayPage';
import ManagePage from './pages/ManagePage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import TermsOfUsePage from './pages/TermsOfUsePage';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
        <Route path="/terms-of-use" element={<TermsOfUsePage />} />
        <Route path="/" element={<GiveawayPage />} />
        <Route path="/:id" element={<GiveawayPage />} />
        <Route path="/:id/manage" element={<ManagePage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
