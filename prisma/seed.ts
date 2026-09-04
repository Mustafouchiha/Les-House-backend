import { PrismaClient, Unit, Role } from "@prisma/client";

const prisma = new PrismaClient();
const ADMIN_PHONE = process.env.ADMIN_SEED_PHONE || "+998901234567";
const USD_UZS = Number(process.env.DEFAULT_USD_UZS || 12800);

const CATEGORIES = [
  "Pol", "Stropila", "Reyka", "Yog'och gul", "MDF gul", "Plintus", "Taxta", "Brus",
  "Doska", "Fanera", "MDF", "DSP", "OSB", "Gipsokarton", "Blok", "Vagonka", "Plita",
];
const TYPES = ["Xom", "Quritilgan", "Qoplamali", "Laminatlangan", "Yon mahsulot"];
const DEPARTMENTS = ["Savdo", "Ombor", "Kassa", "Xarid", "Moliya", "Yetkazib berish", "Boshqaruv"];
const POSITIONS = ["Direktor", "Boshqaruvchi", "Operator", "Sotuvchi", "Omborchi", "Kassir", "Yetkazib beruvchi"];

// mirrors the "Taxta Bozor" mockup's PRODUCTS
const PRODUCTS = [
  { sku: "TX-25150", name: "Taxta 25×150×3000", cat: "Taxta", unit: Unit.M3, material: "Sasna", quality: "1-sort", dims: [25, 150, 3000], sell: 3_200_000, cost: 2_600_000, min: 2_900_000, qty: 18.4, minStock: 12, rating: 4.6 },
  { sku: "BR-100", name: "Brus 100×100×4000", cat: "Brus", unit: Unit.M3, material: "Archa", quality: "1-sort", dims: [100, 100, 4000], sell: 3_850_000, cost: 3_150_000, min: 3_500_000, qty: 6.2, minStock: 8, rating: 4.4 },
  { sku: "VG-12", name: "Vagonka 12×96×2000", cat: "Vagonka", unit: Unit.M2, material: "Sasna", quality: "Premium", dims: [12, 96, 2000], sell: 78_000, cost: 58_000, min: 70_000, qty: 240, minStock: 120, rating: 4.8 },
  { sku: "FN-18", name: "Fanera 18 mm 1220×2440", cat: "Fanera", unit: Unit.PIECE, material: "Qayin", quality: "2-sort", dims: [18, 1220, 2440], sell: 465_000, cost: 380_000, min: 430_000, qty: 34, minStock: 20, rating: 4.5 },
  { sku: "RK-2040", name: "Reyka 20×40×3000", cat: "Reyka", unit: Unit.PIECE, material: "Sasna", quality: "Standard", dims: [20, 40, 3000], sell: 21_000, cost: 15_000, min: 19_000, qty: 410, minStock: 200, rating: 4.2 },
  { sku: "OSB-9", name: "OSB-3 9 mm 1250×2500", cat: "OSB", unit: Unit.PIECE, material: "OSB", quality: "Standard", dims: [9, 1250, 2500], sell: 289_000, cost: 232_000, min: 270_000, qty: 11, minStock: 25, rating: 4.1 },
  { sku: "GK-12", name: "Gipsokarton 12.5 mm 1200×2500", cat: "Gipsokarton", unit: Unit.PIECE, material: "Gips", quality: "Standard", dims: [12.5, 1200, 2500], sell: 82_000, cost: 62_000, min: 76_000, qty: 150, minStock: 60, rating: 4.7 },
  { sku: "BL-20", name: "Gaz blok 200×300×600", cat: "Blok", unit: Unit.PIECE, material: "Beton", quality: "Standard", dims: [200, 300, 600], sell: 15_000, cost: 11_000, min: 13_500, qty: 2000, minStock: 500, rating: 4.3 },
];

const CUSTOMERS = [
  { name: "Alisher Qurilish MChJ", phone: "+998901234501" },
  { name: "Bekzod aka", phone: "+998938872109" },
  { name: "Nur Dizayn", phone: "+998974025510" },
  { name: "Farhod usta", phone: "+998913307422" },
  { name: "Sherzod Mebel", phone: "+998991556003" },
];

async function main() {
  const branch = await prisma.branch.upsert({
    where: { id: "seed-branch-asaka" },
    create: { id: "seed-branch-asaka", name: "Asaka — markaziy", city: "Asaka" },
    update: {},
  });

  for (const name of DEPARTMENTS)
    await prisma.department.upsert({ where: { name }, create: { name }, update: {} });
  for (const name of POSITIONS)
    await prisma.position.upsert({ where: { name }, create: { name }, update: {} });

  const catMap = new Map<string, string>();
  for (const name of CATEGORIES) {
    const c = await prisma.productCategory.upsert({ where: { name }, create: { name }, update: {} });
    catMap.set(name, c.id);
  }
  for (const name of TYPES)
    await prisma.productType.upsert({ where: { name }, create: { name }, update: {} });

  // seeded admin employee — first user to link this phone becomes ADMIN
  const dir = await prisma.position.findUnique({ where: { name: "Direktor" } });
  const boshq = await prisma.department.findUnique({ where: { name: "Boshqaruv" } });
  await prisma.employee.upsert({
    where: { phone: ADMIN_PHONE },
    create: {
      firstName: "Bosh", lastName: "Admin", phone: ADMIN_PHONE, role: Role.ADMIN, status: "ACTIVE",
      positionId: dir?.id, departmentId: boshq?.id, branchId: branch.id, startedAt: new Date(),
    },
    update: { role: Role.ADMIN, status: "ACTIVE" },
  });

  // extra demo employees for the dev role picker
  const demoStaff: Array<[string, string, Role, string, string]> = [
    ["Manager", "+998901111111", Role.MANAGER, "Boshqaruvchi", "Boshqaruv"],
    ["Operator", "+998902222222", Role.OPERATOR, "Operator", "Ombor"],
    ["Sotuvchi", "+998903333333", Role.WORKER, "Sotuvchi", "Savdo"],
  ];
  for (const [last, phone, role, posName, depName] of demoStaff) {
    const pos = await prisma.position.findUnique({ where: { name: posName } });
    const dep = await prisma.department.findUnique({ where: { name: depName } });
    await prisma.employee.upsert({
      where: { phone },
      create: {
        firstName: "Demo", lastName: last, phone, role, status: "ACTIVE",
        positionId: pos?.id, departmentId: dep?.id, branchId: branch.id, startedAt: new Date(),
      },
      update: { role, status: "ACTIVE" },
    });
  }

  for (const p of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { sku: p.sku },
      create: {
        sku: p.sku,
        name: p.name,
        categoryId: catMap.get(p.cat),
        branchId: branch.id,
        material: p.material,
        quality: p.quality,
        unit: p.unit,
        dimX: p.dims[0],
        dimY: p.dims[1],
        length: p.dims[2],
        cost: p.cost,
        startPrice: p.sell,
        minPrice: p.min,
        sellPrice: p.sell,
        minStock: p.minStock,
        rating: p.rating,
        receivedQty: p.qty,
        stockQty: p.qty,
      },
      update: {},
    });
    const hasBatch = await prisma.inventoryBatch.findFirst({ where: { productId: product.id } });
    if (!hasBatch) {
      await prisma.inventoryBatch.create({
        data: {
          productId: product.id,
          supplierName: "Andijon LES",
          quantity: p.qty,
          quantityLeft: p.qty,
          unitCost: p.cost,
          currency: "UZS",
          receivedAt: new Date(Date.now() - 7 * 864e5),
        },
      });
    }
  }

  for (const c of CUSTOMERS)
    await prisma.customer.upsert({ where: { phone: c.phone }, create: c, update: {} });

  await prisma.exchangeRate.create({ data: { pair: "USD/UZS", rate: USD_UZS, source: "seed" } });

  console.log("Seed complete. Admin phone:", ADMIN_PHONE);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
