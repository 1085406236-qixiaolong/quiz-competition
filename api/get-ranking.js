// Vercel API路由 - 获取排行榜数据
const axios = require('axios');

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN || 'O8DKbmBQfaXkPjs1zwqcEDmGnwb';
const RANKING_TABLE_ID = process.env.RANKING_TABLE_ID || 'tblezLIbZN7keSxn';

async function getAccessToken() {
    const response = await axios.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
            app_id: FEISHU_APP_ID,
            app_secret: FEISHU_APP_SECRET
        }
    );
    
    if (response.data.code !== 0) {
        throw new Error('获取令牌失败: ' + response.data.msg);
    }
    
    return response.data.tenant_access_token;
}

module.exports = async function handler(req, res) {
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const accessToken = await getAccessToken();
        
        const response = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${RANKING_TABLE_ID}/records`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                },
                params: {
                    sort: '["累计总分 DESC"]',
                    page_size: 50
                }
            }
        );
        
        if (response.data.code === 0) {
            const records = response.data.data.items.map((item, index) => ({
                rank: index + 1,
                userName: item.fields['多行文本'] || '匿名用户',
                totalScore: item.fields['累计总分'] || 0,
                accuracy: item.fields['累计正确率'] || 0,
                days: item.fields['答题天数'] || 0,
                consecutiveDays: item.fields['连续天数'] || 0
            }));
            
            return res.status(200).json({
                success: true,
                data: records
            });
        } else {
            throw new Error('获取排名失败: ' + response.data.msg);
        }
        
    } catch (error) {
        console.error('API错误:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
