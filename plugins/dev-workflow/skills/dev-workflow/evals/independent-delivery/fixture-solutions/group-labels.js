export function groupLabels(values){return [...new Set(values.map(x=>x.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'en'));}
