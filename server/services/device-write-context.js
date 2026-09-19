/** Temporary personal requests keep their original authority across awaits.
 * This is a write lease, not another permission resolver. Normal requests pay
 * one empty AsyncLocalStorage lookup and perform no authorization queries. */
import {AsyncLocalStorage} from 'node:async_hooks';

const leases=new AsyncLocalStorage(),installed=new WeakSet(),wrapped=new WeakSet();
export function withDeviceWriteLease(assertCurrent,work) {
  return leases.run({assertCurrent,checking:false},work);
}
/** Reserved for the canonical session store and rollback/cleanup bookkeeping.
 * A stale response must still finish without restoring a tombstoned session. */
export function withoutDeviceWriteLease(work) {return leases.run(undefined,work);}
function assertWriteLease() {
  const lease=leases.getStore();if(!lease||lease.checking)return;
  lease.checking=true;
  try {lease.assertCurrent();}finally {lease.checking=false;}
}
function protectStatement(statement) {
  if(statement.readonly||wrapped.has(statement))return statement;
  wrapped.add(statement);
  for(const method of ['run','get','all']) {
    const original=statement[method];
    statement[method]=function(...args){assertWriteLease();return original.apply(this,args);};
  }
  const iterate=statement.iterate;
  statement.iterate=function(...args){
    assertWriteLease();const iterator=iterate.apply(this,args);
    return {
      next(...values){try{assertWriteLease();return iterator.next(...values);}catch(error){iterator.return?.();throw error;}},
      return(...values){return iterator.return?.(...values)||{done:true};},
      throw(...values){return iterator.throw?.(...values);},
      [Symbol.iterator](){return this;},
    };
  };
  return statement;
}
export function installDeviceWriteLease(database) {
  if(!database)return database;
  if(installed.has(database))return database;
  const prepare=database.prepare,exec=database.exec,pragma=database.pragma;
  database.prepare=function(...args){return protectStatement(prepare.apply(this,args));};
  database.exec=function(...args){assertWriteLease();return exec.apply(this,args);};
  // A PRAGMA can change database state; SQLite's pragma helper executes directly.
  database.pragma=function(...args){assertWriteLease();return pragma.apply(this,args);};
  installed.add(database);return database;
}
