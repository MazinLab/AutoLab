import { Navigate, Route, Routes } from "react-router-dom";

import { ActivityPage } from "./pages/activity";
import { AccessionResolverPage } from "./pages/browse/AccessionResolverPage";
import { BrowseListPage } from "./pages/browse/BrowseListPage";
import { BrowsePage } from "./pages/browse/BrowsePage";
import { EntityPage } from "./pages/entity/EntityPage";
import { MountPage } from "./pages/mount";
import { NewEntityPage } from "./pages/new";
import { QuickNotePage } from "./pages/notes";
import { ReviewQueuePage } from "./pages/queue";
import { ScanPage } from "./pages/scan";
import { AppShell } from "./shell/AppShell";
import "./pages/capture.css";
import "./themes/lcars.css";
import "./themes/litho.css";
import "./themes/blueprint.css";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<BrowsePage />} />
        <Route path="/browse/:slug" element={<BrowseListPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/e/:accession" element={<AccessionResolverPage />} />
        <Route path="/entity/:id" element={<EntityPage />} />
        <Route path="/new" element={<NewEntityPage />} />
        <Route path="/notes/new" element={<QuickNotePage />} />
        <Route path="/queue" element={<ReviewQueuePage />} />
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/mount" element={<MountPage />} />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </AppShell>
  );
}
