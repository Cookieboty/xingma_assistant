// 必须最先 import：各模块在加载时读取 process.env.DB_ENABLED，需在此之前载入 .env
import * as dotenv from 'dotenv';
dotenv.config();
