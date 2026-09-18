import { Navigate } from 'react-router-dom';

/** Back-compat alias: NFT holdings live under Collection. */
export default function NftRedirect() {
  return <Navigate to="/collection" replace />;
}
