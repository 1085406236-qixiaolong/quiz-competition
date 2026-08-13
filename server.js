/**
 * 飞书答题系统后端服务
 * 用于保存答题数据到飞书多维表格
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3004;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 配置信息
const CONFIG = {
    // 飞书应用配置
    appId: process.env.FEISHU_APP_ID || 'YOUR_APP_ID',
    appSecret: process.env.FEISHU_APP_SECRET || 'YOUR_APP_SECRET',
    
    // 多维表格配置
    bitableAppToken: 'O8DKbmBQfaXkPjs1zwqcEDmGnwb',
    answerTableId: 'tblbNkR7fv6MTMCC',
    rankingTableId: 'tblezLIbZN7keSxn',
    wrongTableId: process.env.WRONG_TABLE_ID || 'YOUR_WRONG_TABLE_ID',
    awardsTableId: process.env.AWARDS_TABLE_ID || 'YOUR_AWARDS_TABLE_ID',
    
    // 访问令牌缓存
    accessToken: null,
    tokenExpireTime: 0
};

/**
 * 获取飞书访问令牌
 */
async function getAccessToken() {
    const now = Date.now();
    
    // 检查缓存是否有效
    if (CONFIG.accessToken && now < CONFIG.tokenExpireTime) {
        return CONFIG.accessToken;
    }
    
    try {
        const response = await axios.post(
            'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
            {
                app_id: CONFIG.appId,
                app_secret: CONFIG.appSecret
            }
        );
        
        if (response.data.code === 0) {
            CONFIG.accessToken = response.data.tenant_access_token;
            CONFIG.tokenExpireTime = now + (response.data.expire - 300) * 1000;
            return CONFIG.accessToken;
        } else {
            throw new Error(`获取令牌失败: ${response.data.msg}`);
        }
    } catch (error) {
        console.error('获取访问令牌错误:', error);
        throw error;
    }
}

/**
 * 计算单题得分
 */
function getQuestionScore(questionIndex, userAnswer) {
    const quizData = [
        { answer: 0, type: '单选题' },
        { answer: 1, type: '单选题' },
        { answer: [0, 1, 3], type: '多选题' },
        { answer: 1, type: '判断题' },
        { answer: [0, 1, 3], type: '多选题' },
        { answer: [0, 1, 3], type: '多选题' },
        { answer: 1, type: '单选题' },
        { answer: 2, type: '单选题' },
        { answer: 0, type: '单选题' },
        { answer: 2, type: '单选题' }
    ];
    
    if (userAnswer === null || userAnswer === undefined) return 0;
    
    const quiz = quizData[questionIndex];
    
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

/**
 * 更新积分排名表（每日取最高分累计）
 * 逻辑：
 *   1. 查询该用户今日所有答题记录，取最高分
 *   2. 查询排名表，如果今日已累计过，用今日最高分替换
 *   3. 累计总分 = 历史总分 + 今日最高分
 */
async function updateRanking(userOpenId, userName, score, timeSpent, correctCount, accuracy) {
    try {
        const accessToken = await getAccessToken();
        const today = new Date().toISOString().split('T')[0];
        
        // ====== 第1步：查询该用户今日所有答题记录，取最高分 ======
        const todayRecordsResponse = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.answerTableId}/records`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` },
                params: {
                    filter: `CurrentValue.[多行文本]="${userOpenId}"`,
                    page_size: 100
                }
            }
        );
        
        const allRecords = todayRecordsResponse.data.data.items || [];
        
        // 筛选今日记录
        const todayRecords = allRecords.filter(r => {
            const recordDate = new Date(r.fields['答题日期']).toISOString().split('T')[0];
            return recordDate === today;
        });
        
        // 今日最高分（含本次）
        const todayScores = todayRecords.map(r => r.fields['今日总分'] || 0);
        const todayMaxScore = Math.max(...todayScores, score);
        
        // 今日最高分对应的正确率和用时
        const todayBestRecord = todayRecords.find(r => (r.fields['今日总分'] || 0) === todayMaxScore);
        const todayBestAccuracy = todayBestRecord ? (todayBestRecord.fields['今日正确率'] || accuracy) : accuracy;
        const todayBestTime = todayBestRecord ? (todayBestRecord.fields['今日用时(分钟)'] || timeSpent / 60) : timeSpent / 60;
        
        console.log(`用户 ${userOpenId} 今日答题 ${todayRecords.length} 次，最高分: ${todayMaxScore}`);
        
        // ====== 第2步：查询排名表 ======
        const searchResponse = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.rankingTableId}/records`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` },
                params: {
                    filter: `CurrentValue.[多行文本]="${userOpenId}"`
                }
            }
        );
        
        const existingRecords = searchResponse.data.data.items || [];
        
        // 计算连续天数
        const allDates = [...new Set(allRecords.map(r => {
            return new Date(r.fields['答题日期']).toISOString().split('T')[0];
        }))];
        if (!allDates.includes(today)) allDates.push(today);
        allDates.sort();
        const consecutiveDays = calculateConsecutiveDaysFromDates(allDates);
        
        // 计算连续奖励分
        let bonusScore = 0;
        if (consecutiveDays >= 15) bonusScore = 250;
        else if (consecutiveDays >= 10) bonusScore = 120;
        else if (consecutiveDays >= 5) bonusScore = 50;
        
        if (existingRecords.length > 0) {
            // ====== 更新现有记录 ======
            const record = existingRecords[0];
            const lastDate = record.fields['上次答题日期'] ? 
                new Date(record.fields['上次答题日期']).toISOString().split('T')[0] : '';
            const oldTodayScore = record.fields['今日最高分'] || 0;
            const currentTotalScore = record.fields['累计总分'] || 0;
            
            let newTotalScore;
            
            if (lastDate === today) {
                // 今天已累计过，用今日最高分替换
                if (todayMaxScore > oldTodayScore) {
                    // 今日最高分更高，替换
                    newTotalScore = currentTotalScore - oldTodayScore + todayMaxScore;
                    console.log(`更新今日最高分: ${oldTodayScore} -> ${todayMaxScore}`);
                } else {
                    // 今日最高分没变
                    newTotalScore = currentTotalScore;
                }
            } else {
                // 今日首次累计
                newTotalScore = currentTotalScore + todayMaxScore;
            }
            
            // 计算累计正确率和用时
            const currentDays = record.fields['答题天数'] || 0;
            const newDays = lastDate === today ? currentDays : currentDays + 1;
            const currentCorrect = record.fields['累计正确率'] || 0;
            const newCorrect = Math.round(((currentCorrect * (newDays - 1) + todayBestAccuracy) / newDays) * 100) / 100;
            const currentTime = record.fields['累计用时(分钟)'] || 0;
            const newTime = lastDate === today ? currentTime : Math.round((currentTime + todayBestTime) * 10) / 10;
            
            await axios.put(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.rankingTableId}/records/${record.record_id}`,
                {
                    fields: {
                        '多行文本': userOpenId,
                        '答题人姓名': userName || userOpenId,
                        '累计总分': newTotalScore + bonusScore,
                        '累计正确率': newCorrect,
                        '累计用时(分钟)': newTime,
                        '答题天数': newDays,
                        '连续天数': consecutiveDays,
                        '连续奖励分': bonusScore,
                        '今日最高分': todayMaxScore,
                        '上次答题日期': new Date().getTime()
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            console.log(`排名更新: 累计总分=${newTotalScore + bonusScore}, 今日最高分=${todayMaxScore}`);
            
        } else {
            // ====== 创建新记录 ======
            await axios.post(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.rankingTableId}/records`,
                {
                    fields: {
                        '多行文本': userOpenId,
                        '答题人姓名': userName || userOpenId,
                        '累计总分': todayMaxScore + bonusScore,
                        '累计正确率': accuracy,
                        '累计用时(分钟)': Math.round(timeSpent / 60 * 10) / 10,
                        '答题天数': 1,
                        '连续天数': 1,
                        '连续奖励分': 0,
                        '首次达标日期': new Date().getTime(),
                        '排名等级': '普通',
                        '今日最高分': todayMaxScore,
                        '上次答题日期': new Date().getTime()
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            console.log(`新建排名: 累计总分=${todayMaxScore}, 今日最高分=${todayMaxScore}`);
        }
        
    } catch (error) {
        console.error('更新排名错误:', error);
    }
}

/**
 * 根据日期数组计算连续天数
 */
function calculateConsecutiveDaysFromDates(dates) {
    if (dates.length === 0) return 0;
    
    let consecutive = 1;
    const today = new Date().toISOString().split('T')[0];
    
    // 从今天往前数
    let checkDate = new Date(today);
    
    for (let i = 1; i <= 30; i++) {
        checkDate.setDate(checkDate.getDate() - 1);
        const dateStr = checkDate.toISOString().split('T')[0];
        
        if (dates.includes(dateStr)) {
            consecutive++;
        } else {
            break;
        }
    }
    
    return consecutive;
}

/**
 * 计算连续答题天数
 */
function calculateConsecutiveDays(userOpenId) {
    // 简化逻辑，实际需要查询答题记录表
    return 1;
}

/**
 * 保存错题记录
 */
async function saveWrongQuestions(userOpenId, wrongQuestions) {
    try {
        const accessToken = await getAccessToken();
        
        for (const wq of wrongQuestions) {
            await axios.post(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.wrongTableId}/records`,
                {
                    fields: {
                        '用户ID': userOpenId,
                        '题目ID': wq.id,
                        '题目内容': wq.question,
                        '题型': wq.type,
                        '用户答案': Array.isArray(wq.userAnswer) ? wq.userAnswer.join(',') : wq.userAnswer.toString(),
                        '正确答案': Array.isArray(wq.correctAnswer) ? wq.correctAnswer.join(',') : wq.correctAnswer.toString(),
                        '答题日期': new Date().getTime(),
                        '是否已掌握': '否'
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
        }
        
    } catch (error) {
        console.error('保存错题错误:', error);
    }
}

/**
 * 保存答题记录
 */
app.post('/api/save-record', async (req, res) => {
    try {
        const { userOpenId, userName, score, timeSpent, answers, wrongCount, wrongQuestions, startTime, endTime } = req.body;
        
        console.log('收到请求:', { userOpenId, userName, score });
        
        // 验证参数
        if (!userOpenId || score === undefined || !timeSpent) {
            return res.status(400).json({
                success: false,
                error: '缺少必要参数'
            });
        }
        
        // 获取访问令牌
        const accessToken = await getAccessToken();
        
        // 计算答题详情
        const correctCount = 10 - (wrongCount || 0);
        const accuracy = Math.round((correctCount / 10) * 100);
        const timeMinutes = Math.round(timeSpent / 60 * 10) / 10;
        
        // 构建记录数据
        const recordData = {
            fields: {
                '多行文本': userOpenId,
                '答题人': String(userName || userOpenId),
                '答题日期': new Date(startTime).getTime(),
                '提交时间': new Date(endTime).getTime(),
                '今日总分': score,
                '今日用时(分钟)': timeMinutes,
                // 保存每题答案和得分
                '第1题答案': answers[0] !== null ? String(answers[0]) : '',
                '第1题得分': getQuestionScore(0, answers[0]),
                '第2题答案': answers[1] !== null ? String(answers[1]) : '',
                '第2题得分': getQuestionScore(1, answers[1]),
                '第3题答案': answers[2] !== null ? JSON.stringify(answers[2]) : '',
                '第3题得分': getQuestionScore(2, answers[2]),
                '第4题答案': answers[3] !== null ? String(answers[3]) : '',
                '第4题得分': getQuestionScore(3, answers[3]),
                '第5题答案': answers[4] !== null ? JSON.stringify(answers[4]) : '',
                '第5题得分': getQuestionScore(4, answers[4]),
                '第6题答案': answers[5] !== null ? JSON.stringify(answers[5]) : '',
                '第6题得分': getQuestionScore(5, answers[5]),
                '第7题答案': answers[6] !== null ? String(answers[6]) : '',
                '第7题得分': getQuestionScore(6, answers[6]),
                '第8题答案': answers[7] !== null ? String(answers[7]) : '',
                '第8题得分': getQuestionScore(7, answers[7]),
                '第9题答案': answers[8] !== null ? String(answers[8]) : '',
                '第9题得分': getQuestionScore(8, answers[8]),
                '第10题答案': answers[9] !== null ? String(answers[9]) : '',
                '第10题得分': getQuestionScore(9, answers[9])
            }
        };
        
        // 保存到答题记录表
        const response = await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.answerTableId}/records`,
            recordData,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (response.data.code === 0) {
            // 更新积分排名表
            await updateRanking(userOpenId, score, timeSpent, correctCount, accuracy);
            
            // 保存错题记录
            if (wrongQuestions && wrongQuestions.length > 0) {
                await saveWrongQuestions(userOpenId, wrongQuestions);
            }
            
            res.json({
                success: true,
                data: {
                    recordId: response.data.data.record.id,
                    score: score,
                    timeSpent: timeSpent,
                    correctCount: correctCount,
                    accuracy: accuracy
                }
            });
        } else {
            throw new Error(`保存记录失败: ${response.data.msg}`);
        }
        
    } catch (error) {
        console.error('保存答题记录错误:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 获取排名
 */
app.get('/api/ranking', async (req, res) => {
    try {
        const accessToken = await getAccessToken();
        
        const response = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.rankingTableId}/records`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                },
                params: {
                    sort: '["累计总分 DESC"]',
                    page_size: 20
                }
            }
        );
        
        if (response.data.code === 0) {
            const records = response.data.data.items.map((item, index) => ({
                rank: index + 1,
                userOpenId: item.fields['多行文本'] || '',
                userName: item.fields['多行文本'] || '匿名用户',
                totalScore: item.fields['累计总分'] || 0,
                accuracy: item.fields['累计正确率'] || 0,
                days: item.fields['答题天数'] || 0,
                consecutiveDays: item.fields['连续天数'] || 0
            }));
            
            res.json({
                success: true,
                data: records
            });
        } else {
            throw new Error(`获取排名失败: ${response.data.msg}`);
        }
        
    } catch (error) {
        console.error('获取排名错误:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 获取奖项配置
 */
app.get('/api/awards', async (req, res) => {
    try {
        const accessToken = await getAccessToken();
        
        const response = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.awardsTableId}/records`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );
        
        if (response.data.code === 0) {
            const awards = response.data.data.items.map(item => ({
                id: item.record_id,
                icon: item.fields['奖项图标'] || '🏆',
                title: item.fields['奖项名称'] || '',
                desc: item.fields['奖项说明'] || '',
                winner: item.fields['获奖者'] || null,
                image: item.fields['奖项图片'] || null
            }));
            
            res.json({
                success: true,
                data: awards
            });
        } else {
            throw new Error(`获取奖项失败: ${response.data.msg}`);
        }
        
    } catch (error) {
        console.error('获取奖项错误:', error);
        // 返回默认奖项
        res.json({
            success: true,
            data: [
                { icon: '🥇', title: '合规之星', desc: '总积分排名第1名', winner: null },
                { icon: '🥈', title: '合规先锋', desc: '总积分排名第2-4名', winner: null },
                { icon: '🥉', title: '合规达人', desc: '总积分排名第5-9名', winner: null },
                { icon: '🏅', title: '合规卫士', desc: '全勤且积分≥1500', winner: null },
                { icon: '🎯', title: '百发百中奖', desc: '单日满分次数最多', winner: null },
                { icon: '🔥', title: '全勤战神奖', desc: '15天全勤且正确率≥90%', winner: null },
                { icon: '⚡', title: '最快进步奖', desc: '正确率提升最大', winner: null }
            ]
        });
    }
});

/**
 * 获取用户错题
 */
app.get('/api/wrong-questions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const accessToken = await getAccessToken();
        
        const response = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.wrongTableId}/records`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                },
                params: {
                    filter: `CurrentValue.[用户ID]="${userId}" AND CurrentValue.[是否已掌握]="否"`,
                    page_size: 50
                }
            }
        );
        
        if (response.data.code === 0) {
            const wrongQuestions = response.data.data.items.map(item => ({
                id: item.fields['题目ID'],
                question: item.fields['题目内容'],
                type: item.fields['题型'],
                userAnswer: item.fields['用户答案'],
                correctAnswer: item.fields['正确答案'],
                date: item.fields['答题日期']
            }));
            
            res.json({
                success: true,
                data: wrongQuestions
            });
        } else {
            throw new Error(`获取错题失败: ${response.data.msg}`);
        }
        
    } catch (error) {
        console.error('获取错题错误:', error);
        res.json({
            success: true,
            data: []
        });
    }
});

/**
 * 更新错题状态（标记为已掌握）
 */
app.put('/api/wrong-questions/:recordId/mastered', async (req, res) => {
    try {
        const { recordId } = req.params;
        const accessToken = await getAccessToken();
        
        const response = await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.wrongTableId}/records/${recordId}`,
            {
                fields: {
                    '是否已掌握': '是',
                    '掌握日期': new Date().toISOString().split('T')[0]
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (response.data.code === 0) {
            res.json({
                success: true,
                message: '已标记为掌握'
            });
        } else {
            throw new Error(`更新失败: ${response.data.msg}`);
        }
        
    } catch (error) {
        console.error('更新错题状态错误:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`答题页面: http://localhost:${PORT}/index.html`);
    console.log(`API接口: http://localhost:${PORT}/api`);
});

module.exports = app;
