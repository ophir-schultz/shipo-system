import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const STATE_FILE = path.join(process.env.HOME || '/Users/ophirschultz', 'shipo-marketing/optimization/state.json')
const BLOG_DIR = path.join(process.env.HOME || '/Users/ophirschultz', 'shipo-marketing/blog-posts')
const LINKEDIN_DIR = path.join(process.env.HOME || '/Users/ophirschultz', 'shipo-marketing/linkedin-posts')

export async function GET() {
  try {
    // Read state file
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))

    // Count actual blog posts on disk
    const blogFiles = fs.existsSync(BLOG_DIR)
      ? fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'))
      : []

    // Count linkedin post files
    const linkedinFiles = fs.existsSync(LINKEDIN_DIR)
      ? fs.readdirSync(LINKEDIN_DIR).filter(f => f.endsWith('.md'))
      : []

    // Build activity log from file system
    const activity: { type: string; title: string; date: string; status: string }[] = []

    blogFiles.forEach(file => {
      const filePath = path.join(BLOG_DIR, file)
      const stat = fs.statSync(filePath)
      const title = file.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
      activity.push({
        type: 'blog',
        title,
        date: stat.mtime.toISOString(),
        status: state.blog.posts?.find((p: any) => p.status === 'published') ? 'published' : 'written'
      })
    })

    // Sort by date desc
    activity.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

    return NextResponse.json({
      ...state,
      live: {
        blogPostsOnDisk: blogFiles.length,
        linkedinFilesOnDisk: linkedinFiles.length,
        recentActivity: activity.slice(0, 10)
      }
    })
  } catch (err) {
    return NextResponse.json({ error: 'Could not read marketing state' }, { status: 500 })
  }
}
