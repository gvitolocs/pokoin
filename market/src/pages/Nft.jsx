import { Navigate } from 'react-router-dom';

/** Back-compat alias: NFT holdings live on the MyPokoin Collection tab. */
export default function NftRedirect() {
  return <Navigate to="/mypokoin/collection" replace />;
}
