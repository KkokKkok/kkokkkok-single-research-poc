import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export class Store {
  constructor(directory){this.directory=directory;mkdirSync(resolve(directory,'images'),{recursive:true});this.db=new DatabaseSync(resolve(directory,'cues.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS analyses(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL);`);}
  create(image,bytes,model){const now=new Date().toISOString();const r={schemaVersion:'location-cues-v1',id:randomUUID(),createdAt:now,updatedAt:now,status:'queued',requestedModel:model,promptVersion:'research-cues-v1',image,stages:{},artifacts:{},cues:[],errors:[],humanReviews:{}};writeFileSync(resolve(this.directory,'images',`${r.id}.jpg`),bytes);this.save(r);return r;}
  save(r){r.updatedAt=new Date().toISOString();this.db.prepare('INSERT INTO analyses VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,status=excluded.status,record_json=excluded.record_json').run(r.id,r.createdAt,r.updatedAt,r.status,JSON.stringify(r));return r;}
  get(id){const row=this.db.prepare('SELECT record_json FROM analyses WHERE id=?').get(id);return row?JSON.parse(row.record_json):null;}
  list(){return this.db.prepare('SELECT id,created_at,updated_at,status FROM analyses ORDER BY created_at DESC').all();}
  image(id){if(!this.get(id))return null;return readFileSync(resolve(this.directory,'images',`${id}.jpg`));}
  recover(){for(const row of this.list()){const r=this.get(row.id);if(r.status==='running'){r.status='partial';for(const s of Object.values(r.stages))if(s.status==='running'){s.status='failed';s.error='INTERRUPTED';}this.save(r);}}}
  close(){this.db.close();}
}
