import { TabId } from '../types/models';

interface TabNavProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
}

export function TabNav({ activeTab, onChange }: TabNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Hauptnavigation">
      <button
        type="button"
        className={`bottom-tab ${activeTab === 'offers' ? 'active' : ''}`}
        onClick={() => onChange('offers')}
      >
        <span className="tab-icon" aria-hidden>
          A
        </span>
        <span>Angebote</span>
      </button>
      <button
        type="button"
        className={`bottom-tab ${activeTab === 'aichef' ? 'active' : ''}`}
        onClick={() => onChange('aichef')}
      >
        <span className="tab-icon" aria-hidden>
          AI
        </span>
        <span>AIChef</span>
      </button>
      <button
        type="button"
        className={`bottom-tab ${activeTab === 'later' ? 'active' : ''}`}
        onClick={() => onChange('later')}
      >
        <span className="tab-icon" aria-hidden>
          3
        </span>
        <span>Spaeter</span>
      </button>
    </nav>
  );
}
