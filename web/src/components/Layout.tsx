import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import SectionTabs from './SectionTabs';
import PageHeading from './PageHeading';

export default function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <SectionTabs />
        <main className="flex-1 overflow-y-auto bg-bg">
          <div className="max-w-[1200px] mx-auto p-6 pb-14">
            <PageHeading />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
