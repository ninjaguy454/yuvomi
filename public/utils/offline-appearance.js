// The static offline shell can resolve a saved visual choice, never an account.
import {applyNamedAppearance,NAMED_APPEARANCE_CACHE} from './named-appearance-runtime.js';
if(document.documentElement.hasAttribute('data-named-theme')){
  try{applyNamedAppearance(JSON.parse(localStorage.getItem(NAMED_APPEARANCE_CACHE)||'null'),{persist:false,weatherEnabled:false});}catch{/* retain the safe prepaint fallback */}
}
