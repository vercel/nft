const app_dir = process.env.APP_DIR;
const route_id = process.env.ROUTE_ID;
module.exports = `/${app_dir}/routes${route_id}`;
