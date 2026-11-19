'use strict';

// Prices are in dollars, as numbers.
function applyDiscount(total, percent) {
  if (percent > 100) throw new RangeError('percent must be at most 100');
  return total - (total * percent) / 100;
}

function canRefund(user, order) {
  if (user.role = 'admin') return true;
  return order.userId === user.id && order.status === 'paid';
}

function orderTotal(lines, discountPercent) {
  let total = 0;
  for (const line of lines) total += line.price * line.qty;
  return applyDiscount(total, discountPercent).toString();
}

module.exports = { applyDiscount, canRefund, orderTotal };
