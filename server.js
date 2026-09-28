import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import morgan from 'morgan';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'dev-only-change-me') throw new Error('JWT_SECRET must be set in production');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WAVE_ENABLED = process.env.WAVE_ENABLED === 'true';
const ORANGE_MONEY_ENABLED = process.env.ORANGE_MONEY_ENABLED === 'true';
const hits = new Map();
const rateLimit = (limit=120, windowMs=60000) => (req,res,next)=>{ const key=(req.ip||'unknown')+':'+req.path; const now=Date.now(); const old=hits.get(key)||{n:0,t:now}; if(now-old.t>windowMs){old.n=0;old.t=now;} old.n++; hits.set(key,old); if(old.n>limit) return res.status(429).json({error:'RATE_LIMITED'}); next(); };
setInterval(()=>{const now=Date.now();for(const [k,v] of hits)if(now-v.t>120000)hits.delete(k)},120000).unref();

app.use(helmet({ contentSecurityPolicy: false }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(morgan('tiny'));
app.use(express.static('public'));
app.use(rateLimit());

const slugify = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'boutique';
const sign = user => jwt.sign({ sub:user.id, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
async function auth(req,res,next){ const token=req.cookies.vendo_token; if(!token) return res.status(401).json({error:'AUTH_REQUIRED'}); try{ req.user=jwt.verify(token,JWT_SECRET); next(); }catch{return res.status(401).json({error:'SESSION_EXPIRED'});} }
const seller = (req,res,next)=> req.user.role==='SELLER'||req.user.role==='ADMIN' ? next() : res.status(403).json({error:'FORBIDDEN'});
const asyncRoute = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const id = x => x?.sub;

async function uniqueSlug(base, storeId=null){ let s=slugify(base), n=1; while(await prisma.store.findFirst({where:{slug:s, ...(storeId?{id:{not:storeId}}:{})}})){s=`${slugify(base)}-${n++}`;} return s; }

app.get('/api/version',(req,res)=>res.json({name:'Vendo',version:'5.11.0',environment:process.env.NODE_ENV||'development'}));

app.get('/api/health', asyncRoute(async(req,res)=>{ await prisma.$queryRaw`SELECT 1`; res.json({ok:true,service:'vendo',version:'5.11.0'}); }));
app.get('/api/ready', asyncRoute(async(req,res)=>{ await prisma.$queryRaw`SELECT 1`; res.json({ready:true}); }));

app.post('/api/auth/register', asyncRoute(async(req,res)=>{
 const body=z.object({email:z.string().email(),password:z.string().min(8),name:z.string().min(2).max(80),phone:z.string().min(6).max(30).optional(),storeName:z.string().min(2).max(80)}).parse(req.body);
 if(await prisma.user.findUnique({where:{email:body.email.toLowerCase()}})) return res.status(409).json({error:'EMAIL_EXISTS'});
 const passwordHash=await bcrypt.hash(body.password,12); const slug=await uniqueSlug(body.storeName);
 const user=await prisma.user.create({data:{email:body.email.toLowerCase(),passwordHash,name:body.name,phone:body.phone,store:{create:{name:body.storeName,slug,subscription:{create:{plan:'FREE'}}}}}});
 res.cookie('vendo_token',sign(user),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*864e5});
 res.status(201).json({id:user.id,email:user.email,storeSlug:slug});
}));

app.post('/api/auth/login', asyncRoute(async(req,res)=>{ const body=z.object({email:z.string().email(),password:z.string()}).parse(req.body); const user=await prisma.user.findUnique({where:{email:body.email.toLowerCase()}}); if(!user||!(await bcrypt.compare(body.password,user.passwordHash))) return res.status(401).json({error:'INVALID_CREDENTIALS'}); res.cookie('vendo_token',sign(user),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*864e5}); res.json({ok:true}); }));
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('vendo_token');res.json({ok:true});});
app.get('/api/auth/me',auth,asyncRoute(async(req,res)=>{const u=await prisma.user.findUnique({where:{id:id(req.user)},include:{store:{include:{subscription:true}}}}); res.json({id:u.id,email:u.email,name:u.name,phone:u.phone,role:u.role,store:u.store});}));

async function storeForUser(uid){return prisma.store.findUnique({where:{ownerId:uid},include:{subscription:true}});}
app.get('/api/dashboard',auth,seller,asyncRoute(async(req,res)=>{
 const store=await storeForUser(id(req.user)); if(!store)return res.status(404).json({error:'STORE_NOT_FOUND'});
 const [products,orders,customers,revenue,pending,unread]=await Promise.all([
  prisma.product.count({where:{storeId:store.id,active:true}}), prisma.order.count({where:{storeId:store.id}}), prisma.customer.count({where:{storeId:store.id}}), prisma.order.aggregate({where:{storeId:store.id,status:{not:'CANCELLED'},paymentStatus:'PAID'},_sum:{total:true}}), prisma.order.count({where:{storeId:store.id,status:'PENDING'}}), prisma.notification.count({where:{storeId:store.id,read:false}})
 ]);
 res.json({store,stats:{products,orders,customers,revenue:revenue._sum.total||0,pending,unread}});
}));

app.get('/api/products',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user)); const p=await prisma.product.findMany({where:{storeId:s.id},include:{category:true,variants:{where:{active:true},orderBy:{name:'asc'}}},orderBy:{createdAt:'desc'}});res.json(p);}));
app.post('/api/products',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user)); const b=z.object({name:z.string().min(2),price:z.coerce.number().int().nonnegative(),stock:z.coerce.number().int().nonnegative().default(0),description:z.string().max(5000).optional(),imageUrl:z.string().url().optional().or(z.literal('')),categoryId:z.string().optional()}).parse(req.body); const slug=slugify(b.name); const exists=await prisma.product.findFirst({where:{storeId:s.id,slug}}); if(exists)return res.status(409).json({error:'PRODUCT_SLUG_EXISTS'}); const p=await prisma.product.create({data:{storeId:s.id,name:b.name,slug,price:b.price,stock:b.stock,description:b.description,imageUrl:b.imageUrl||null,categoryId:b.categoryId||null}});res.status(201).json(p);}));
app.patch('/api/products/:id',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user)); const b=z.object({name:z.string().min(2).optional(),price:z.coerce.number().int().nonnegative().optional(),compareAt:z.coerce.number().int().nonnegative().nullable().optional(),stock:z.coerce.number().int().nonnegative().optional(),active:z.boolean().optional(),description:z.string().max(5000).optional(),imageUrl:z.string().url().optional().or(z.literal('')),categoryId:z.string().nullable().optional()}).parse(req.body); const p=await prisma.product.updateMany({where:{id:req.params.id,storeId:s.id},data:{...b,imageUrl:b.imageUrl===''?null:b.imageUrl}});if(!p.count)return res.status(404).json({error:'NOT_FOUND'});res.json({ok:true});}));
app.delete('/api/products/:id',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user)); const p=await prisma.product.updateMany({where:{id:req.params.id,storeId:s.id},data:{active:false}});res.json({ok:p.count>0});}));
app.get('/api/products/:id/variants',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const p=await prisma.product.findFirst({where:{id:req.params.id,storeId:s.id}});if(!p)return res.status(404).json({error:'NOT_FOUND'});res.json(await prisma.productVariant.findMany({where:{productId:p.id},orderBy:{name:'asc'}}));}));
app.post('/api/products/:id/variants',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const p=await prisma.product.findFirst({where:{id:req.params.id,storeId:s.id}});if(!p)return res.status(404).json({error:'NOT_FOUND'});const b=z.object({name:z.string().min(1).max(80),sku:z.string().max(80).optional(),price:z.coerce.number().int().nonnegative().optional(),stock:z.coerce.number().int().nonnegative().default(0),imageUrl:z.string().url().optional().or(z.literal(''))}).parse(req.body);try{res.status(201).json(await prisma.productVariant.create({data:{productId:p.id,name:b.name,sku:b.sku||null,price:b.price??null,stock:b.stock,imageUrl:b.imageUrl||null}}));}catch(e){if(e.code==='P2002')return res.status(409).json({error:'VARIANT_EXISTS'});throw e;}}));
app.patch('/api/products/:productId/variants/:variantId',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const p=await prisma.product.findFirst({where:{id:req.params.productId,storeId:s.id}});if(!p)return res.status(404).json({error:'NOT_FOUND'});const b=z.object({name:z.string().min(1).max(80).optional(),sku:z.string().max(80).nullable().optional(),price:z.coerce.number().int().nonnegative().nullable().optional(),stock:z.coerce.number().int().nonnegative().optional(),imageUrl:z.string().url().nullable().optional(),active:z.boolean().optional()}).parse(req.body);const r=await prisma.productVariant.updateMany({where:{id:req.params.variantId,productId:p.id},data:{...b,imageUrl:b.imageUrl===''?null:b.imageUrl}});if(!r.count)return res.status(404).json({error:'VARIANT_NOT_FOUND'});res.json({ok:true});}));
app.delete('/api/products/:productId/variants/:variantId',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const p=await prisma.product.findFirst({where:{id:req.params.productId,storeId:s.id}});if(!p)return res.status(404).json({error:'NOT_FOUND'});const r=await prisma.productVariant.updateMany({where:{id:req.params.variantId,productId:p.id},data:{active:false}});res.json({ok:r.count>0});}));

app.get('/api/orders/:id',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const o=await prisma.order.findFirst({where:{id:req.params.id,storeId:s.id},include:{items:{include:{variant:true}},customer:true,payments:true}});if(!o)return res.status(404).json({error:'NOT_FOUND'});res.json(o);}));
app.get('/api/orders',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));res.json(await prisma.order.findMany({where:{storeId:s.id},include:{items:{include:{variant:true}},customer:true},orderBy:{createdAt:'desc'}}));}));
app.patch('/api/orders/:id',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const b=z.object({status:z.enum(['PENDING','CONFIRMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED']).optional(),paymentStatus:z.enum(['PENDING','PAID','FAILED','REFUNDED']).optional(),deliveryStatus:z.enum(['PENDING','ASSIGNED','IN_TRANSIT','DELIVERED','FAILED']).optional(),trackingNumber:z.string().max(100).optional()}).parse(req.body);const updated=await prisma.$transaction(async tx=>{const order=await tx.order.findFirst({where:{id:req.params.id,storeId:s.id},include:{items:true}});if(!order)throw Object.assign(new Error('NOT_FOUND'),{status:404});if(b.status==='CANCELLED'&&order.status!=='CANCELLED'&&!order.inventoryRestored){for(const item of order.items){if(item.variantId)await tx.productVariant.update({where:{id:item.variantId},data:{stock:{increment:item.quantity}}});else await tx.product.update({where:{id:item.productId},data:{stock:{increment:item.quantity}}});}await tx.order.update({where:{id:order.id},data:{...b,inventoryRestored:true}});}else{await tx.order.update({where:{id:order.id},data:b});}return tx.order.findUnique({where:{id:order.id},include:{items:true}});});res.json(updated);}));

app.get('/api/customers',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));res.json(await prisma.customer.findMany({where:{storeId:s.id},include:{_count:{select:{orders:true}}},orderBy:{updatedAt:'desc'}}));}));
app.get('/api/delivery/zones',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));res.json(await prisma.deliveryZone.findMany({where:{storeId:s.id},orderBy:{name:'asc'}}));}));
app.post('/api/delivery/zones',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const b=z.object({name:z.string().min(2),fee:z.coerce.number().int().nonnegative()}).parse(req.body);res.status(201).json(await prisma.deliveryZone.create({data:{storeId:s.id,...b}}));}));
app.get('/api/categories',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));res.json(await prisma.category.findMany({where:{storeId:s.id},include:{_count:{select:{products:true}}},orderBy:{name:'asc'}}));}));
app.post('/api/categories',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const b=z.object({name:z.string().min(2).max(60)}).parse(req.body);const slug=slugify(b.name);const exists=await prisma.category.findFirst({where:{storeId:s.id,slug}});if(exists)return res.status(409).json({error:'CATEGORY_EXISTS'});res.status(201).json(await prisma.category.create({data:{storeId:s.id,name:b.name,slug}}));}));
app.delete('/api/categories/:id',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const r=await prisma.category.deleteMany({where:{id:req.params.id,storeId:s.id}});res.json({ok:r.count>0});}));

app.get('/api/coupons',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));res.json(await prisma.coupon.findMany({where:{storeId:s.id},orderBy:{createdAt:'desc'}}));}));
app.post('/api/coupons',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const b=z.object({code:z.string().min(2).max(30),type:z.enum(['PERCENT','FIXED']),value:z.coerce.number().int().positive(),minAmount:z.coerce.number().int().nonnegative().default(0),maxUses:z.coerce.number().int().positive().optional(),expiresAt:z.string().datetime().optional()}).parse(req.body);if(b.type==='PERCENT'&&b.value>100)return res.status(400).json({error:'PERCENT_MAX_100'});const code=b.code.toUpperCase().trim();const exists=await prisma.coupon.findFirst({where:{storeId:s.id,code}});if(exists)return res.status(409).json({error:'COUPON_EXISTS'});res.status(201).json(await prisma.coupon.create({data:{storeId:s.id,code,type:b.type,value:b.value,minAmount:b.minAmount,maxUses:b.maxUses,expiresAt:b.expiresAt?new Date(b.expiresAt):null}}));}));
app.patch('/api/coupons/:id',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const b=z.object({active:z.boolean().optional(),maxUses:z.coerce.number().int().positive().nullable().optional(),expiresAt:z.string().datetime().nullable().optional()}).parse(req.body);const r=await prisma.coupon.updateMany({where:{id:req.params.id,storeId:s.id},data:{...b,expiresAt:b.expiresAt===undefined?undefined:(b.expiresAt?new Date(b.expiresAt):null)}});if(!r.count)return res.status(404).json({error:'NOT_FOUND'});res.json({ok:true});}));

app.patch('/api/store/settings',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const b=z.object({name:z.string().min(2).max(80).optional(),description:z.string().max(2000).nullable().optional(),phone:z.string().max(30).nullable().optional(),city:z.string().max(80).nullable().optional(),logoUrl:z.string().url().nullable().optional(),primaryColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()}).parse(req.body);const store=await prisma.store.update({where:{id:s.id},data:b});res.json(store);}));

app.get('/api/analytics',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));const paid=await prisma.order.findMany({where:{storeId:s.id,status:{not:'CANCELLED'},paymentStatus:'PAID'},select:{total:true,createdAt:true},orderBy:{createdAt:'asc'}});const byDay={};for(const o of paid){const d=o.createdAt.toISOString().slice(0,10);byDay[d]=(byDay[d]||0)+o.total;}res.json({days:Object.entries(byDay).map(([date,total])=>({date,total})),total:paid.reduce((a,b)=>a+b.total,0),orders:paid.length});}));

app.get('/api/notifications',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));res.json(await prisma.notification.findMany({where:{storeId:s.id},orderBy:{createdAt:'desc'},take:50}));}));
app.patch('/api/notifications/:id/read',auth,seller,asyncRoute(async(req,res)=>{const s=await storeForUser(id(req.user));await prisma.notification.updateMany({where:{id:req.params.id,storeId:s.id},data:{read:true}});res.json({ok:true});}));

app.get('/api/store/:slug',asyncRoute(async(req,res)=>{const s=await prisma.store.findUnique({where:{slug:req.params.slug},include:{products:{where:{active:true},include:{category:true,variants:{where:{active:true},orderBy:{name:'asc'}}},orderBy:{createdAt:'desc'}},zones:{where:{active:true},orderBy:{fee:'asc'}}}});if(!s)return res.status(404).json({error:'STORE_NOT_FOUND'});res.json({id:s.id,name:s.name,slug:s.slug,description:s.description,phone:s.phone,city:s.city,currency:s.currency,primaryColor:s.primaryColor,products:s.products,zones:s.zones,paymentMethods:['COD',...(WAVE_ENABLED?['WAVE']:[]),...(ORANGE_MONEY_ENABLED?['ORANGE_MONEY']:[])]});}));

app.post('/api/store/:slug/orders',asyncRoute(async(req,res)=>{
 const s=await prisma.store.findUnique({where:{slug:req.params.slug}}); if(!s)return res.status(404).json({error:'STORE_NOT_FOUND'});
 const b=z.object({customer:z.object({name:z.string().min(2),phone:z.string().min(6),city:z.string().optional(),address:z.string().min(3)}),items:z.array(z.object({productId:z.string(),variantId:z.string().optional(),quantity:z.coerce.number().int().min(1).max(100)})).min(1),paymentMethod:z.enum(['COD','WAVE','ORANGE_MONEY']).default('COD'),zoneId:z.string().optional(),couponCode:z.string().optional(),notes:z.string().max(500).optional()}).parse(req.body);
 if ((b.paymentMethod==='WAVE' && !WAVE_ENABLED) || (b.paymentMethod==='ORANGE_MONEY' && !ORANGE_MONEY_ENABLED)) return res.status(503).json({error:'PAYMENT_NOT_CONFIGURED'});
 const result=await prisma.$transaction(async tx=>{
  const ids=b.items.map(x=>x.productId); const products=await tx.product.findMany({where:{id:{in:ids},storeId:s.id,active:true},include:{variants:{where:{active:true}}}}); const map=new Map(products.map(p=>[p.id,p])); let subtotal=0; const lines=[];
  for(const it of b.items){const p=map.get(it.productId);if(!p)throw Object.assign(new Error('PRODUCT_NOT_FOUND'),{status:400});let variant=null;if(it.variantId){variant=p.variants.find(v=>v.id===it.variantId);if(!variant)throw Object.assign(new Error('VARIANT_NOT_FOUND'),{status:400});if(variant.stock<it.quantity)throw Object.assign(new Error(`STOCK_INSUFFICIENT:${variant.name}`),{status:409});}else{if(p.stock<it.quantity)throw Object.assign(new Error(`STOCK_INSUFFICIENT:${p.name}`),{status:409});}const unitPrice=variant?.price??p.price;subtotal+=unitPrice*it.quantity;lines.push({product:p,variant,quantity:it.quantity,unitPrice});}
  let shippingFee=0;if(b.zoneId){const z=await tx.deliveryZone.findFirst({where:{id:b.zoneId,storeId:s.id,active:true}});if(!z)throw Object.assign(new Error('DELIVERY_ZONE_INVALID'),{status:400});shippingFee=z.fee;}
  let discount=0;if(b.couponCode){const c=await tx.coupon.findFirst({where:{storeId:s.id,code:b.couponCode.toUpperCase(),active:true}});if(c && (!c.expiresAt||c.expiresAt>new Date()) && (!c.maxUses||c.uses<c.maxUses) && subtotal>=c.minAmount){discount=c.type==='PERCENT'?Math.floor(subtotal*c.value/100):Math.min(c.value,subtotal);await tx.coupon.update({where:{id:c.id},data:{uses:{increment:1}}});}}
  const total=Math.max(0,subtotal+shippingFee-discount); const customer=await tx.customer.upsert({where:{storeId_phone:{storeId:s.id,phone:b.customer.phone}},update:{name:b.customer.name,city:b.customer.city,address:b.customer.address},create:{storeId:s.id,...b.customer}});
  const order=await tx.order.create({data:{storeId:s.id,customerId:customer.id,customerName:b.customer.name,customerPhone:b.customer.phone,customerCity:b.customer.city,customerAddress:b.customer.address,subtotal,shippingFee,discount,total,paymentMethod:b.paymentMethod,notes:b.notes,items:{create:lines.map(x=>({productId:x.product.id,variantId:x.variant?.id||null,name:x.variant?`${x.product.name} — ${x.variant.name}`:x.product.name,unitPrice:x.unitPrice,quantity:x.quantity}))},payments:{create:{provider:b.paymentMethod,amount:total}}}});
  for(const x of lines){ if(x.variant){ const r=await tx.productVariant.updateMany({where:{id:x.variant.id,active:true,stock:{gte:x.quantity}},data:{stock:{decrement:x.quantity}}}); if(!r.count) throw Object.assign(new Error(`STOCK_INSUFFICIENT:${x.variant.name}`),{status:409}); } else { const r=await tx.product.updateMany({where:{id:x.product.id,storeId:s.id,active:true,stock:{gte:x.quantity}},data:{stock:{decrement:x.quantity}}}); if(!r.count) throw Object.assign(new Error(`STOCK_INSUFFICIENT:${x.product.name}`),{status:409}); } }
  await tx.notification.create({data:{storeId:s.id,title:'Nouvelle commande',message:`Commande ${order.id.slice(-8)} — ${total.toLocaleString('fr-FR')} FCFA`}});
  return order;
 });
 res.status(201).json({orderId:result.id,total:result.total,paymentStatus:result.paymentStatus,paymentMethod:result.paymentMethod});
}));

app.get('/api/store/:slug/orders/:id',asyncRoute(async(req,res)=>{const o=await prisma.order.findFirst({where:{id:req.params.id,store:{slug:req.params.slug}},select:{id:true,status:true,paymentMethod:true,paymentStatus:true,deliveryStatus:true,total:true,trackingNumber:true,createdAt:true}});if(!o)return res.status(404).json({error:'ORDER_NOT_FOUND'});res.json(o);}));

// Provider-neutral webhook endpoint. Connect the official Wave/Orange Money callbacks here after merchant activation.
app.post('/api/payments/webhook/:provider',asyncRoute(async(req,res)=>{
 if (WEBHOOK_SECRET && req.get('x-vendo-webhook-secret') !== WEBHOOK_SECRET) return res.status(401).json({error:'WEBHOOK_UNAUTHORIZED'});
 const provider=String(req.params.provider).toUpperCase();if(!['WAVE','ORANGE_MONEY'].includes(provider))return res.status(404).json({error:'PROVIDER_NOT_SUPPORTED'});const body=req.body||{};const ref=body.externalRef||body.reference||body.transaction_id;if(!ref)return res.status(400).json({error:'REFERENCE_REQUIRED'});const tx=await prisma.paymentTransaction.findFirst({where:{externalRef:String(ref),provider:provider}});if(!tx)return res.status(202).json({ok:true,ignored:true});const status=body.status==='success'||body.status==='paid'?'PAID':body.status==='failed'?'FAILED':null;if(status){await prisma.$transaction([prisma.paymentTransaction.update({where:{id:tx.id},data:{status,rawPayload:JSON.stringify(body),webhookEventId:body.event_id?String(body.event_id):undefined}}),prisma.order.update({where:{id:tx.orderId},data:{paymentStatus:status}})]);}res.json({ok:true});}));

app.get('/api/admin/overview',auth,asyncRoute(async(req,res)=>{if(req.user.role!=='ADMIN')return res.status(403).json({error:'FORBIDDEN'});const [users,stores,orders]=await Promise.all([prisma.user.count({where:{role:'SELLER'}}),prisma.store.count(),prisma.order.count()]);res.json({users,stores,orders});}));
app.get('/api/admin/stores',auth,asyncRoute(async(req,res)=>{if(req.user.role!=='ADMIN')return res.status(403).json({error:'FORBIDDEN'});res.json(await prisma.store.findMany({include:{owner:{select:{name:true,email:true,phone:true}},subscription:true},orderBy:{createdAt:'desc'}}));}));

app.use((req,res,next)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'NOT_FOUND'});next();});
app.use((err,req,res,next)=>{console.error(err);if(err?.name==='ZodError')return res.status(400).json({error:'VALIDATION_ERROR',details:err.issues});if(err?.code==='P2002')return res.status(409).json({error:'DUPLICATE_RESOURCE'});res.status(err.status||500).json({error:err.message||'SERVER_ERROR'});});
app.get('*splat',(req,res)=>res.sendFile(process.cwd()+'/public/index.html'));
const HOST = process.env.HOST || '0.0.0.0';
const server=app.listen(PORT,HOST,()=>console.log(`Vendo running on ${HOST}:${PORT}`));
const shutdown=async(signal)=>{console.log(`Received ${signal}; shutting down.`);server.close(async()=>{await prisma.$disconnect();process.exit(0);});};
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
