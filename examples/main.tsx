import { createRoot } from 'react-dom/client';
import { HostPage } from './HostPage';
import './site.css';

const defaultTarget = {
  gateway: import.meta.env.VITE_CHAT_DEFAULT_GATEWAY,
  sessionKey: import.meta.env.VITE_CHAT_DEFAULT_SESSION,
};

createRoot(document.getElementById('root')!).render(<HostPage defaultTarget={defaultTarget} />);
