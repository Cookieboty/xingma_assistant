/**
 * 业主任务中心 /「本商品任务」可见 job 类型白名单。
 * 与后端 USER_VISIBLE_JOB_TYPES 对齐：新类型默认隐藏，需显式加入。
 */
const USER_VISIBLE_JOB_TYPES = ['promo_image', 'promo_video', 'publish_product'];

function isUserVisibleJobType(type) {
  return USER_VISIBLE_JOB_TYPES.indexOf(String(type || '')) >= 0;
}

module.exports = {
  USER_VISIBLE_JOB_TYPES,
  isUserVisibleJobType,
};
