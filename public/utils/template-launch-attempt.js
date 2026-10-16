/** A pending create is remembered before sending; retries reuse its exact body. */
export function launchAttemptStore(storage,context){
  const key='vidamia.template-launch.'+encodeURIComponent(context);
  return {
    load(){try{const row=JSON.parse(storage.getItem(key));return row&&typeof row.request_key==='string'&&Number.isSafeInteger(row.activity_template_id)&&Array.isArray(row.recipient_user_ids)?row:null;}catch{return null;}},
    save(body){try{storage.setItem(key,JSON.stringify(body));}catch{throw new Error('Your browser could not remember this creation attempt. Allow session storage before creating Activities.');}},
    clear(requestKey){try{const saved=JSON.parse(storage.getItem(key));if(saved?.request_key===requestKey)storage.removeItem(key);}catch{/* A later retry remains safe. */}},
  };
}
