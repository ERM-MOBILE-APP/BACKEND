require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Payslip = require('./models/Payslip');

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// 6 months of demo data ending at current month
function buildPayslips(userId) {
  const now = new Date();
  const data = [];

  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = d.getMonth() + 1;
    const year = d.getFullYear();

    // Slight variation each month for realism
    const basicSalary      = 32000;
    const hraAllowance     = 8000;
    const performanceBonus = i === 0 ? 6000 : i === 1 ? 4500 : 3000;
    const otherEarnings    = 2500;
    const totalGross       = basicSalary + hraAllowance + performanceBonus + otherEarnings;

    const incomeTax       = Math.round(totalGross * 0.05);
    const providentFund   = 1800;
    const healthInsurance = 500;
    const lopDeduction    = i === 3 ? 1200 : 0;
    const otherDeductions = 0;
    const totalDeductions = incomeTax + providentFund + healthInsurance + lopDeduction + otherDeductions;

    data.push({
      user: userId,
      month,
      year,
      monthLabel: `${MONTH_NAMES[month]} ${year}`,
      earnings: { basicSalary, hraAllowance, performanceBonus, otherEarnings },
      deductions: { incomeTax, providentFund, healthInsurance, lopDeduction, otherDeductions },
      totalGross,
      totalDeductions,
      netPay: totalGross - totalDeductions,
      status: 'processed',
      paidVia: 'HDFC Bank',
    });
  }
  return data;
}

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log('Connected to MongoDB');

  const user = await User.findOne({ userId: 'EMP001' });
  if (!user) {
    console.error('User EMP001 not found. Run seed.js first.');
    process.exit(1);
  }

  // Remove old payslips for this user
  await Payslip.deleteMany({ user: user._id });

  const payslips = buildPayslips(user._id);
  await Payslip.insertMany(payslips);

  console.log(`✅ Inserted ${payslips.length} payslips for ${user.name}`);
  payslips.forEach(p => console.log(`   ${p.monthLabel}: ₹${p.netPay.toLocaleString()}`));

  mongoose.disconnect();
}).catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
