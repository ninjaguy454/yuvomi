/** In-process HTTPS-provider transport, retaining real signed OIDC verification. */
import crypto from 'node:crypto';
export const issuer='https://synthetic-prize-idp.example';
const originalFetch=globalThis.fetch,grants=new Map(),access=new Map();
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'synthetic-prize-key',alg:'RS256',use:'sig'});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function token(claims){
  const input=[{alg:'RS256',kid:jwk.kid,typ:'JWT'},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${crypto.sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;
}
export function installProvider(){
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url||String(input));
    if(url.origin!==issuer)return originalFetch(input,options);
    if(url.pathname==='/.well-known/openid-configuration')return json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,userinfo_endpoint:`${issuer}/userinfo`,jwks_uri:`${issuer}/jwks`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_basic'],code_challenge_methods_supported:['S256']});
    if(url.pathname==='/jwks')return json({keys:[jwk]});
    if(url.pathname==='/token'){
      const body=new URLSearchParams(options.body),grant=grants.get(body.get('code'));if(!grant)throw new Error('Unknown one-use fixture code');grants.delete(body.get('code'));
      if(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url')!==grant.challenge)throw new Error('Fixture PKCE mismatch');
      if(body.get('redirect_uri')!==process.env.OIDC_REDIRECT_URI)throw new Error('Fixture redirect mismatch');
      if(grant.gate){grant.entered();await grant.gate;}
      const now=Math.floor(Date.now()/1000),accessToken=crypto.randomUUID();access.set(accessToken,grant.sub);
      return json({access_token:accessToken,token_type:'Bearer',expires_in:300,id_token:token({iss:issuer,aud:process.env.OIDC_CLIENT_ID,sub:grant.sub,nonce:grant.nonce,iat:now,exp:now+300,auth_time:now-(grant.age||0)})});
    }
    if(url.pathname==='/userinfo'){
      const sub=access.get(new Headers(options.headers).get('authorization')?.replace(/^Bearer /i,''));if(!sub)throw new Error('Fixture access token mismatch');
      return json({sub,name:'Synthetic identity',email:'synthetic@example.test',email_verified:true});
    }
    throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
  };
}
export function authorizationCallback(location,options={}){
  const url=new URL(location),code=crypto.randomUUID();
  grants.set(code,{sub:'linked-recipient',nonce:url.searchParams.get('nonce'),challenge:url.searchParams.get('code_challenge'),...options});
  return `/api/v1/auth/oidc/callback?code=${code}&state=${url.searchParams.get('state')}`;
}
export function restoreProvider(){globalThis.fetch=originalFetch;}
