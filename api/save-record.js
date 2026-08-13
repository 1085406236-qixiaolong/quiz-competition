// Vercel API路由 - 保存答题记录到飞书多维表格
const axios = require('axios');

// 飞书配置（从环境变量获取）
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const BITABLE_APP_TOKEN = process.env.BITABLE_APP_TOKEN || 'O8DKbmBQfaXkPjs1zwqcEDmGnwb';
const ANSWER_TABLE_ID = process.env.ANSWER_TABLE_ID || 'tblbNkR7fv6MTMCC';

// 获取飞书访问令牌
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

// 计算单题得分
function getQuestionScore(questionIndex, userAnswer, quizData) {
    if (userAnswer === null || userAnswer === undefined) return 0;
    
    const quiz = quizData[questionIndex];
    if (!quiz) return 0;
    
    if (quiz.type === '多选题') {
        const correct = quiz.answer.sort().toString();
        const user = userAnswer.sort().toString();
        if (correct === user) return 20;
        if (userAnswer.length > 0 && quiz.answer.some(a => userAnswer.includes(a))) return 10;
        return 0;
    } else {
        return userAnswer === quiz.answer ? 10 : 0;
    }
}

module.exports = async function handler(req, res) {
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // 处理预检请求
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // 只允许POST请求
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const { 
            userName, 
            userId, 
            score, 
            timeSpent, 
            answers, 
            quizDate,
            startTime,
            endTime 
        } = req.body;
        
        // 验证参数
        if (!userName || score === undefined || !timeSpent) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        
        // 计算答题详情
        const correctCount = Math.round(score / 10); // 简化计算
        const accuracy = Math.round((correctCount / 10) * 100);
        const timeMinutes = Math.round(timeSpent / 60 * 10) / 10;
        
        // 获取访问令牌
        const accessToken = await getAccessToken();
        
        // 构建记录数据
        const recordData = {
            fields: {
                '多行文本': userName,
                '答题日期': new Date(quizDate || Date.now()).getTime(),
                '提交时间': new Date(endTime || Date.now()).getTime(),
                '今日总分': score,
                '今日用时(分钟)': timeMinutes
            }
        };
        
        // 保存到飞书多维表格
        const response = await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${ANSWER_TABLE_ID}/records`,
            recordData,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (response.data.code === 0) {
            console.log('保存成功:', response.data);
            return res.status(200).json({
                success: true,
                recordId: response.data.data.record.id,
                message: '数据已保存到飞书多维表格'
            });
        } else {
            throw new Error('保存失败: ' + response.data.msg);
        }
        
    } catch (error) {
        console.error('API错误:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}
