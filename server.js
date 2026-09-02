const express=require('express');
const app=express();
const cors=require('cors');
const multer=require('multer');
app.use(cors());
app.use(express.json());
const mongoose=require('mongoose');
const bcrypt=require('bcrypt');
const jwt=require('jsonwebtoken');
const auth=require('./middleware/auth');
const pdfParse=require('pdf-parse');
const fs=require('fs');
const path=require('path')
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
const {GoogleGenerativeAI}=require('@google/generative-ai')
require('dotenv').config();
mongoose.connect(process.env.MONGO_URI)
.then(()=>{
    console.log('MONGODB connected');
})
.catch((err)=>{
    console.log(err)
});
const genAI=new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model=genAI.getGenerativeModel({
    model:'gemini-3.6-flash'
})
const candidateHistory=require('./models/candidateHistory');
const recruiterHistory=require('./models/recruiterHistory');
const User=require('./models/user');
const storage=multer.diskStorage(
    {
        destination:function(req,file,cb){
            cb(null,uploadsDir)
        },
        filename:function(req,file,cb){
            cb(null,Date.now()+'-'+file.originalname)
        }
    }
)
const upload=multer({storage})
app.post('/register',async(req,res)=>{
    const{fullName,email,password,role}=req.body
    console.log(req.body);
    const existingemail=await User.findOne({email});
    if(existingemail){
        return res.status(400).json({
            message:'user already exists.please login!'
        })
    }
    const hashedPassword=await bcrypt.hash(password,10);
    const newuser=new User({
        fullName,
        email,
        password:hashedPassword,
        role
    })
    await newuser.save();
    res.status(201).json({
        message:"user registered successfully",
        fullName:newuser.fullName,
        email:newuser.email,
        role:newuser.role
    })
})
app.post('/login',async(req,res)=>{
    const{email,password}=req.body;
    const existeduser=await User.findOne({email});
    if(!existeduser){
        return res.status(400).json({
            message:"user do not exist.Please do register"
        })
    }
    const isMatch=await bcrypt.compare(password,existeduser.password);
    if(!isMatch){
        return res.status(400).json({
            message:"Invalid credentials"
        })
    }
    const token=jwt.sign(
        {
            id:existeduser._id,
            email:existeduser.email,
            role:existeduser.role
        },
        process.env.JWT_SECRET,
        {
            expiresIn:'1hr'
        }
    )
    return res.status(200).json({
        message:"You have logged in successfully",
        token,
        email:existeduser.email,
        role:existeduser.role,
        fullName:existeduser.fullName
    })
})
app.post('/upload-resume',auth,upload.single('resume'),async(req,res)=>{
    if (!req.file) {
    return res.status(400).json({ message: "Resume file is required" });
    }
    if (!req.body.domain || !req.body.description) {
        return res.status(400).json({ message: "Domain and description are required" });
    }
    try{
        const domain=req.body.domain;
        const description=req.body.description;
        const pdfBuffer=fs.readFileSync(req.file.path);
        const data=await pdfParse(pdfBuffer);
        const resumeText=data.text;
        const prompt = `You are an expert ATS (Applicant Tracking System) and technical recruiter. Analyze the following resume based on: Domain: ${domain} Job Description: ${description} Resume: ${resumeText} Evaluate how well the resume matches the domain and job description. Provide the output in exactly this format: ATS Score: XX/100 Matching Skills: - Skill 1 - Skill 2 - Skill 3 Missing Skills: - Skill 1 - Skill 2 - Skill 3 Strengths: - Point 1 - Point 2 - Point 3 Weaknesses: - Point 1 - Point 2 - Point 3 Suggestions: - Point 1 - Point 2 - Point 3 Keep the ATS score realistic. Focus on technical skills, projects, tools, frameworks, and experience mentioned in the resume.`;
        const result=await model.generateContent(prompt);
        const analysis=result.response.text();
        const match=analysis.match(/\d+/);
        const atsScore=match?Number(match[0]):0
        await candidateHistory.create(({
            userId:req.user.id,
            domain,
            description,
            atsScore,
            analysis
        }))
        console.log('============ANALYSIS===========');
        console.log(analysis);
        return res.status(200).json({
            message:'Resume uploaded successfully',
            analysis
        })
    }
    catch(err){
        console.log(err);
        if(err.status === 429){
        return res.status(429).json({
            message:"Gemini quota exceeded. Please try again later."
        });
        }
        return res.status(500).json({
            message:'Error parsing resume'
        })
    }
})
app.post('/upload-resumes',auth,upload.array('resumes'),async(req,res)=>{
    if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: "Resumes are required" });
    }
    if (!req.body.domain || !req.body.description) {
        return res.status(400).json({ message: "Domain and description are required" });
    }
    try{
        const results=[];
        const domain=req.body.domain;
        const description=req.body.description;

        for(const file of req.files){

            try{
                const pdfBuffer=fs.readFileSync(file.path);

                console.log("Processing:", file.originalname);

                const data=await pdfParse(pdfBuffer);
                const resumeText=data.text;

                console.log("Parsed Successfully:", file.originalname);

                const prompt=`You are an ATS system. Domain:${domain} Job Description:${description} Resume:${resumeText} Analyze the resume and return ONLY in this format: ATS Score: XX. Replace XX with a number between 0 and 100. Do not return any explanation, strengths, weaknesses, skills, or suggestions. Only return the ATS Score.`;

                const result=await model.generateContent(prompt);
                const analysis=await result.response.text();

                const match=analysis.match(/\d+/);
                const atsScore=match ? Number(match[0]) : 0;

                results.push({
                    fileName:file.originalname,
                    atsScore
                });

            }
            catch(err){
                console.log(`Failed to parse ${file.originalname}`);
                console.log(err);
                if (err.status === 429) {
                return res.status(429).json({
                    message: "Gemini quota exceeded. Please try again later."
                });
            }
                results.push({
                    fileName:file.originalname,
                    atsScore:0,
                    error:"Could not parse PDF"
                });
            }

            if(fs.existsSync(file.path)){
                fs.unlinkSync(file.path);
            }
        }

        results.sort((a,b)=>b.atsScore-a.atsScore);

        const topAtsScore=results.length>0 ? results[0].atsScore : 0;

        await recruiterHistory.create({
            userId:req.user.id,
            domain,
            description,
            topAtsScore,
            results
        });

        return res.status(200).json({
            message:'Resumes uploaded successfully',
            results
        });

    }
    catch(err){
        console.log(err);

        if(err.status===429){
            return res.status(429).json({
                message:"Gemini quota exceeded. Please try again later."
            });
        }

        return res.status(500).json({
            message:'Error parsing resumes'
        });
    }
});
app.get('/candidate-history',auth,async(req,res)=>{
    try{
        const history=await candidateHistory.find({
            userId:req.user.id
        }).sort({createdAt:-1});
        return res.status(200).json({
            history
        })
    }
    catch(err){
        console.log(err);
        return res.status(500).json({
            message:'Error fetching history'
        })
    }
})
app.get('/recruiter-history',auth,async(req,res)=>{
    try{
        const history=await recruiterHistory.find({
            userId:req.user.id
        }).sort({createdAt:-1})
        return res.status(200).json({
            history
        })
    }
    catch(err){
        console.log(err);
        return res.status(500).json({
            message:'Error fetching history'
        })
    }
})
app.listen(5000,()=>{
    console.log('Backend running successfully')
})
