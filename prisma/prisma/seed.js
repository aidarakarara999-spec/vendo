import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const run = async () => {
  const passwordHash = await bcrypt.hash('VendoDemo2026!', 12);

  const u = await prisma.user.upsert({
    where: { email: 'demo@vendo.sn' },
    update: {},
    create: {
      email: 'demo@vendo.sn',
      passwordHash,
      name: 'Vendo Demo',
      phone: '770000000',
      store: {
        create: {
          name: 'Vendo Demo',
          slug: 'vendo-demo',
          city: 'Dakar',
          subscription: { create: { plan: 'FREE' } },
          zones: {
            create: [
              { name: 'Dakar', fee: 1500 },
              { name: 'Régions', fee: 3000 }
            ]
          }
        }
      }
    }
  });

  const s = await prisma.store.findUnique({
    where: { ownerId: u.id }
  });

  if (s) {
    const cat = await prisma.category.upsert({
      where: {
        storeId_slug: {
          storeId: s.id,
          slug: 'general'
        }
      },
      update: {},
      create: {
        storeId: s.id,
        name: 'Général',
        slug: 'general'
      }
    });

    for (const p of [
      { name: 'Parfum Pocket', price: 8000, stock: 20 },
      { name: 'T-shirt Premium', price: 12000, stock: 15 }
    ]) {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      await prisma.product.upsert({
        where: {
          storeId_slug: {
            storeId: s.id,
            slug
          }
        },
        update: {},
        create: {
          storeId: s.id,
          categoryId: cat.id,
          slug,
          name: p.name,
          price: p.price,
          stock: p.stock
        }
      });
    }
  }

  console.log('Seed OK: demo@vendo.sn / VendoDemo2026!');
};

run().finally(() => prisma.$disconnect());
